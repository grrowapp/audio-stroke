import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'api_client.dart';
import 'audio_io.dart';
import 'frame_packer.dart';
import 'ws_connection.dart';

class PhoneRunResult {
  PhoneRunResult({required this.finished, required this.metrics, required this.sessionId});

  /// True when the server sent `finished` before the connection closed.
  final bool finished;
  final Map<String, num> metrics;
  final String sessionId;
}

/// The conversation client: Dart port of cli/phone.ts. Speaks docs/API_EVENTS.md over a
/// [WsConnection]; the microphone and speaker are [AudioSource] / [AudioSink].
class PhoneClient {
  PhoneClient({
    required this.api,
    required this.micSource,
    required this.sink,
    required this.log,
    this.connector = IoWsConnection.connect,
    Duration Function()? clock,
    DateTime Function()? wallClock,
    this.maxBacklogBytes = targetSampleRate * 2, // 1 s of PCM16, like phone.ts
    this.stopCloseDelay = const Duration(milliseconds: 500),
  })  : _clock = clock ?? _stopwatchClock(),
        _wall = wallClock ?? DateTime.now;

  final PhoneApi api;
  final AudioSource micSource;
  final AudioSink sink;
  final void Function(String line) log;
  final WsConnector connector;
  final int maxBacklogBytes;
  final Duration stopCloseDelay;
  final Duration Function() _clock;
  final DateTime Function() _wall;

  static Duration Function() _stopwatchClock() {
    final sw = Stopwatch()..start();
    return () => sw.elapsed;
  }

  double _nowMs() => _clock().inMicroseconds / 1000.0;

  void _say(String s) {
    final t = _wall().toUtc().toIso8601String(); // 2026-11-04T00:00:00.000Z
    log('${t.substring(11, 23)} $s');
  }

  // ---- state
  WsConnection? _ws;
  bool _micEnabled = false;
  bool get micEnabled => _micEnabled;
  _Playback? _playback;
  final Map<String, Future<Uint8List>> _cache = {};
  String _lastPhase = '';
  final Map<String, num> _metrics = {};
  bool _done = false;
  double _tPlayMsg = 0;
  double? _tSpeechStopped;
  bool _backlogStopped = false;
  StreamSubscription<Uint8List>? _micSub;
  AudioSource? _source;
  final Completer<void> _closed = Completer<void>();

  /// Number of the currently active playback generation's id, or null.
  String? get currentPlaybackId => _playback?.id;

  Future<Uint8List> _fetchAudio(String id) {
    final cached = _cache[id];
    if (cached != null) return cached;
    final p = api.fetchAudio(id);
    p.then((_) {}, onError: (Object _) {
      _cache.remove(id);
    });
    return _cache[id] = p;
  }

  void _send(Map<String, Object?> o) {
    final ws = _ws;
    if (ws != null && ws.isOpen) ws.sendText(jsonEncode(o));
  }

  /// Runs one conversation for [sess] until the connection closes.
  Future<PhoneRunResult> run(SessionInfo sess) async {
    _say('session ${sess.sessionId} v${sess.version} backend=${sess.backend}'
        '${sess.mockRealtime ? ' (MOCK: audio not understood)' : ''} barge_in=${sess.bargeInEnabled}');
    await _fetchAudio(sess.entryAudioId);

    final url = '${api.wsBase}/ws?session_id=${Uri.encodeQueryComponent(sess.sessionId)}';
    final ws = await connector(url, api.headers);
    _ws = ws;
    _say('connected');

    // microphone → 20 ms frames, gated by the server's mic_enabled
    final packer = FramePacker(inputRate: sess.mockRealtime ? targetSampleRate : micSource.sampleRate);
    _source = sess.mockRealtime ? SilentAudioSource() : micSource;
    final stream = await _source!.start();
    _micSub = stream.listen((chunk) {
      final frames = packer.add(chunk);
      for (final f in frames) {
        if (!_micEnabled || !ws.isOpen) continue;
        if (ws.bufferedBytes > maxBacklogBytes) {
          if (!_backlogStopped) {
            _backlogStopped = true;
            _say('audio backlog > 1 s, stopping');
            _send({'type': 'stop'});
          }
          return;
        }
        ws.sendBinary(f);
      }
    }, onError: (Object e) => _say('mic error: $e'));

    ws.messages.listen(
      (d) {
        final text = d is String ? d : (d is List<int> ? utf8.decode(d, allowMalformed: true) : null);
        if (text == null) return;
        Object? m;
        try {
          m = jsonDecode(text);
        } catch (_) {
          return;
        }
        if (m is Map<String, dynamic>) handleMessage(m);
      },
      onDone: () {
        if (!_closed.isCompleted) _closed.complete();
      },
      onError: (Object _) {
        if (!_closed.isCompleted) _closed.complete();
      },
    );

    await _closed.future;
    await _cleanup();
    _say('closed${_done ? '' : ' (connection dropped)'}; metrics ${jsonEncode(_metrics)}');
    return PhoneRunResult(finished: _done, metrics: Map.of(_metrics), sessionId: sess.sessionId);
  }

  Future<void> _cleanup() async {
    _stopCurrent(null, null);
    await _micSub?.cancel();
    _micSub = null;
    try {
      await _source?.stop();
    } catch (_) {}
    try {
      await _ws?.close();
    } catch (_) {}
  }

  /// Skip the current playback (answer now), like the `s` key in phone.ts.
  void skip() {
    _say('skip');
    _stopCurrent(null, 'user_skip');
  }

  /// Ask the server to stop; the connection is closed shortly after.
  void stop() {
    _say('stop');
    _send({'type': 'stop'});
    _stopCurrent(null, null);
    Timer(stopCloseDelay, () {
      _ws?.close();
    });
  }

  // ---- server events (public so tests can drive it without a socket)
  void handleMessage(Map<String, dynamic> m) {
    switch (m['type']) {
      case 'state':
        _micEnabled = m['mic_enabled'] == true;
        final line = '${m['phase']}${m['speaking'] == true ? '(speaking)' : ''} node=${m['node_id']} turn=${m['turn_id']} '
            'mic=${_micEnabled ? 'ON' : 'off'} backend=${m['backend']}';
        if (line != _lastPhase) {
          _say('state $line');
          _lastPhase = line;
        }
      case 'prefetch':
        for (final id in ((m['audio_ids'] as List?) ?? const []).map((e) => '$e')) {
          _fetchAudio(id).then((b) => sink.prefetch(id, b)).catchError((Object _) {});
        }
      case 'play':
        unawaited(_playAudio(m));
      case 'playback_stop':
        _stopCurrent(m['playback_id'] as String?, 'barge_in');
        _say('playback_stop (barge-in)');
      case 'interrupted':
        _say('interrupted: 「${m['text']}」 at ${m['position_ms']} ms (remaining ${m['remaining_ms']} ms)');
      case 'speech_started':
        _say('… speech_started');
      case 'speech_stopped':
        _tSpeechStopped = _nowMs();
        _say('… speech_stopped');
      case 'preview':
        _say('preview ${m['branch_id']} (${m['label']})');
      case 'final':
        _say('FINAL ${m['branch_id']} (${m['label']})'
            '${m['fallback_reason'] != null ? ' fallback:${m['fallback_reason']}' : ''}'
            '${m['reason'] != null ? '  ${m['reason']}' : ''}');
      case 'final_invalidated':
        _say('final invalidated: ${m['reason']}');
      case 'metric':
        final v = m['value_ms'];
        if (v is num) _metrics['${m['name']}'] = v;
        _say('metric ${m['name']}=$v');
      case 'playback_error':
        _say('playback_error: ${m['message']}');
      case 'realtime_error':
        _say('backend error: ${m['code']} ${m['message']}');
      case 'finished':
        _done = true;
        _say('finished ${m['phase']} ${m['reason']}${m['message'] != null ? ' ${m['message']}' : ''}');
        if (m['realtime_usage'] != null) _say('usage ${jsonEncode(m['realtime_usage'])}');
      default:
        _say('? ${m['type']}');
    }
  }

  // ---- playback with generation management: only the newest playback may ack.
  void _stopCurrent(String? onlyId, String? reason) {
    final pb = _playback;
    if (pb == null || (onlyId != null && pb.id != onlyId)) return;
    pb.canceled = true;
    final handle = pb.handle;
    final pos = handle?.positionMs ?? 0;
    if (handle != null) {
      unawaited(handle.stop().catchError((Object _) => 0));
    }
    if (reason != null) {
      _send({'type': 'playback_canceled', 'playback_id': pb.id, 'reason': reason, 'position_ms': pos});
    }
    _playback = null;
  }

  Future<void> _playAudio(Map<String, dynamic> m) async {
    _tPlayMsg = _nowMs();
    _stopCurrent(null, null);
    final pb = _Playback(m['playback_id'] as String);
    _playback = pb;
    _say('▶ ${m['utterance_key']}${m['interruptible'] == true ? ' (interruptible)' : ''}: 「${m['text']}」');

    Uint8List bytes;
    try {
      bytes = await _fetchAudio(m['audio_id'] as String);
    } catch (e) {
      if (_playback != pb) return;
      _send({'type': 'playback_failed', 'playback_id': pb.id, 'error': 'load: $e'});
      return;
    }
    if (_playback != pb) return;

    final PlaybackHandle handle;
    try {
      handle = sink.start(m['audio_id'] as String, bytes);
    } catch (e) {
      _playback = null;
      _send({'type': 'playback_failed', 'playback_id': pb.id, 'error': 'play: $e'});
      return;
    }
    pb.handle = handle;

    // Contract: `started` completes before `completed`. The newest playback is the only one that may ack.
    try {
      await handle.started;
    } catch (e) {
      if (_playback != pb || pb.canceled) return;
      _playback = null;
      _send({'type': 'playback_failed', 'playback_id': pb.id, 'error': 'play: $e'});
      return;
    }
    if (_playback != pb || pb.canceled) return;
    _sendStarted(pb, m);

    unawaited(handle.completed.then((_) {
      if (_playback != pb || pb.canceled) return;
      _playback = null;
      _send({'type': 'playback_ended', 'playback_id': pb.id});
    }, onError: (Object e) {
      if (_playback != pb || pb.canceled) return;
      _playback = null;
      _send({'type': 'playback_failed', 'playback_id': pb.id, 'error': 'play: $e'});
    }));
  }

  void _sendStarted(_Playback pb, Map<String, dynamic> m) {
    pb.startedSent = true;
    final startedAt = _nowMs();
    _send({'type': 'playback_started', 'playback_id': pb.id});
    _send({
      'type': 'client_metric',
      'name': 'decision_message_to_playback_started_ms',
      'value_ms': (startedAt - _tPlayMsg).round(),
      'playback_id': pb.id,
      'turn_id': m['turn_id'],
    });
    final ss = _tSpeechStopped;
    if (ss != null) {
      _send({
        'type': 'client_metric',
        'name': 'client_notification_speech_stopped_to_playback_started_ms',
        'value_ms': (startedAt - ss).round(),
        'playback_id': pb.id,
        'turn_id': m['turn_id'],
      });
      _tSpeechStopped = null;
    }
  }
}

class _Playback {
  _Playback(this.id);
  final String id;
  PlaybackHandle? handle;
  bool canceled = false;
  bool startedSent = false;
}
