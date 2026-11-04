// ignore_for_file: experimental_member_use
// StreamAudioSource is marked experimental by just_audio; it is the only way to play from memory.
import 'dart:async';
import 'dart:typed_data';

import 'package:audio_session/audio_session.dart';
import 'package:just_audio/just_audio.dart' hide AudioSource;
import 'package:record/record.dart';

import '../protocol/audio_io.dart';

/// playAndRecord + voiceChat: enables the hardware echo canceller on iOS and routes output to
/// the loudspeaker (not the earpiece) via defaultToSpeaker. Call once before a conversation.
Future<void> configureConversationAudioSession() async {
  final session = await AudioSession.instance;
  await session.configure(AudioSessionConfiguration(
    avAudioSessionCategory: AVAudioSessionCategory.playAndRecord,
    avAudioSessionCategoryOptions: AVAudioSessionCategoryOptions.defaultToSpeaker |
        AVAudioSessionCategoryOptions.allowBluetooth,
    avAudioSessionMode: AVAudioSessionMode.voiceChat,
    avAudioSessionRouteSharingPolicy: AVAudioSessionRouteSharingPolicy.defaultPolicy,
    androidAudioAttributes: const AndroidAudioAttributes(
      contentType: AndroidAudioContentType.speech,
      usage: AndroidAudioUsage.voiceCommunication,
    ),
    androidAudioFocusGainType: AndroidAudioFocusGainType.gain,
  ));
  await session.setActive(true);
}

/// Microphone via the `record` package: PCM16 mono stream with echo cancel / noise suppression
/// / auto gain. The audio session is managed by [configureConversationAudioSession], not by record.
class RecordAudioSource implements AudioSource {
  RecordAudioSource({this.sampleRate = 24000});

  @override
  final int sampleRate;

  // Created on start(), so a source that is never started (MOCK sessions) allocates nothing.
  AudioRecorder? _recorder;

  @override
  Future<Stream<Uint8List>> start() async {
    final rec = _recorder ??= AudioRecorder();
    if (!await rec.hasPermission()) {
      throw StateError('マイク権限がありません（設定アプリで許可してください）');
    }
    await rec.ios?.manageAudioSession(false); // null on non-iOS
    return rec.startStream(RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: sampleRate,
      numChannels: 1,
      echoCancel: true,
      noiseSuppress: true,
      autoGain: true,
    ));
  }

  @override
  Future<void> stop() async {
    final rec = _recorder;
    _recorder = null;
    if (rec == null) return;
    try {
      await rec.stop();
    } finally {
      await rec.dispose();
    }
  }
}

class _BytesSource extends StreamAudioSource {
  _BytesSource(this.bytes, this.mime);
  final Uint8List bytes;
  final String mime;

  @override
  Future<StreamAudioResponse> request([int? start, int? end]) async {
    final s = start ?? 0;
    final e = end ?? bytes.length;
    return StreamAudioResponse(
      sourceLength: bytes.length,
      contentLength: e - s,
      offset: s,
      stream: Stream.value(bytes.sublist(s, e)),
      contentType: mime,
    );
  }
}

/// Speaker via just_audio. Whole mp3/wav files are played from memory (StreamAudioSource,
/// served to the native player through just_audio's local proxy). Prefetch hints preload
/// players so that `start` only has to call `play`.
class JustAudioSink implements AudioSink {
  JustAudioSink({this.maxPrepared = 4});

  final int maxPrepared;
  final Map<String, Future<AudioPlayer>> _prepared = {}; // insertion order = age

  Future<AudioPlayer> _prepare(String id, Uint8List bytes) async {
    final p = AudioPlayer(handleAudioSessionActivation: false);
    try {
      await p.setAudioSource(_BytesSource(bytes, sniffAudioFormat(bytes).mime));
    } catch (_) {
      await p.dispose();
      rethrow;
    }
    return p;
  }

  @override
  Future<void> prefetch(String audioId, Uint8List bytes) async {
    if (_prepared.containsKey(audioId)) return;
    while (_prepared.length >= maxPrepared) {
      final oldest = _prepared.keys.first;
      final f = _prepared.remove(oldest)!;
      unawaited(f.then((p) => p.dispose(), onError: (Object _) {}));
    }
    final f = _prepare(audioId, bytes);
    _prepared[audioId] = f;
    f.then((_) {}, onError: (Object _) {
      _prepared.remove(audioId);
    });
  }

  @override
  PlaybackHandle start(String audioId, Uint8List bytes) {
    final prepared = _prepared.remove(audioId);
    return _JustHandle(prepared ?? _prepare(audioId, bytes));
  }

  @override
  Future<void> dispose() async {
    final all = _prepared.values.toList();
    _prepared.clear();
    for (final f in all) {
      try {
        await (await f).dispose();
      } catch (_) {}
    }
  }
}

class _JustHandle implements PlaybackHandle {
  _JustHandle(Future<AudioPlayer> player) {
    _run(player);
  }

  final Completer<void> _started = Completer<void>();
  final Completer<void> _completed = Completer<void>();
  AudioPlayer? _player;
  bool _stopped = false;
  int _lastPos = 0;

  Future<void> _run(Future<AudioPlayer> pf) async {
    try {
      final p = await pf;
      _player = p;
      if (_stopped) {
        await _disposePlayer();
        return;
      }
      // play() completes when playback ends (or is stopped); "started" = playing and ready.
      final ended = p.play();
      await p.playerStateStream.firstWhere((s) => s.playing && s.processingState == ProcessingState.ready);
      if (!_started.isCompleted) _started.complete();
      await ended;
      if (!_stopped && !_completed.isCompleted) _completed.complete();
      await _disposePlayer();
    } catch (e) {
      if (_stopped) return;
      if (!_started.isCompleted) {
        _started.completeError(e);
      } else if (!_completed.isCompleted) {
        _completed.completeError(e);
      }
      // `completed` may have no listener yet when `started` fails.
      _completed.future.catchError((Object _) {});
    }
  }

  @override
  Future<void> get started => _started.future;

  @override
  Future<void> get completed => _completed.future;

  @override
  int get positionMs => _player?.position.inMilliseconds ?? _lastPos;

  @override
  Future<int> stop() async {
    _stopped = true;
    final p = _player;
    if (p == null) return 0;
    _lastPos = p.position.inMilliseconds;
    try {
      await p.stop();
    } catch (_) {}
    await _disposePlayer();
    return _lastPos;
  }

  bool _disposed = false;

  /// The player is disposed exactly once, whichever of end / stop / error gets here first.
  Future<void> _disposePlayer() async {
    final p = _player;
    if (p == null || _disposed) return;
    _disposed = true;
    try {
      await p.dispose();
    } catch (_) {}
  }
}
