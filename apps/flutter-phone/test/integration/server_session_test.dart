// Headless end-to-end run of the protocol layer against a real server (mock providers).
//
//   AUDIO_STROKE_SERVER=http://127.0.0.1:18123 flutter test test/integration
//   (or: tool/run_integration.sh, which builds and starts a throw-away mock server)
//
// Skipped when AUDIO_STROKE_SERVER is not set. The server must run the MOCK configuration
// (no .env): the test creates a scenario with the mock generator, approves it, then drives the
// bundled sample conversation (select_need → demo → confirm_demo → yes → end_demo) with a
// silent AudioSource, an instantly-completing AudioSink and `mock_vad` control messages.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_phone/protocol/api_client.dart';
import 'package:flutter_phone/protocol/audio_io.dart';
import 'package:flutter_phone/protocol/phone_client.dart';
import 'package:flutter_phone/protocol/ws_connection.dart';
import 'package:test/test.dart';

final _server = Platform.environment['AUDIO_STROKE_SERVER']?.trim() ?? '';

Future<Map<String, dynamic>> _call(String method, String path, [Object? body]) async {
  final c = HttpClient();
  try {
    final req = await c.openUrl(method, Uri.parse('$_server$path'));
    req.headers.set('origin', Uri.parse(_server).origin);
    if (body != null) {
      final bytes = utf8.encode(jsonEncode(body));
      req.headers.set('content-type', 'application/json');
      req.contentLength = bytes.length;
      req.add(bytes);
    }
    final res = await req.close();
    final text = await res.transform(utf8.decoder).join();
    if (res.statusCode != 200) throw StateError('$method $path → ${res.statusCode} $text');
    return jsonDecode(text) as Map<String, dynamic>;
  } finally {
    c.close(force: true);
  }
}

Future<Map<String, dynamic>> _waitJob(String id) async {
  final end = DateTime.now().add(const Duration(seconds: 30));
  while (DateTime.now().isBefore(end)) {
    final j = await _call('GET', '/api/jobs/$id');
    if (const ['succeeded', 'failed', 'canceled', 'interrupted'].contains(j['status'])) return j;
    await Future<void>.delayed(const Duration(milliseconds: 100));
  }
  throw StateError('job timeout');
}

Future<String> _prepareReadyScenario() async {
  final g = await _call('POST', '/api/scenarios/generate', {'instruction': '問い合わせ受付'});
  final j = await _waitJob(g['job_id'] as String);
  expect(j['status'], 'succeeded', reason: jsonEncode(j));
  final sid = (j['result'] as Map)['scenario_id'] as String;
  final vo = (await _call('GET', '/api/config'))['voice_options'] as Map<String, dynamic>;
  final a = await _call('POST', '/api/scenarios/$sid/versions/1/approve', {
    'voice': {
      'provider': (vo['providers'] as List).first,
      'model': (vo['models'] as List).first,
      'voice': (vo['voices'] as List).first,
      'speed': 1.0,
      'style_id': 'polite',
    },
    'confirm_reviewed': true,
  });
  final j2 = await _waitJob(a['job_id'] as String);
  expect(j2['status'], 'succeeded', reason: jsonEncode(j2));
  return sid;
}

void main() {
  test('play → ack → finished against the real server (mock)', () async {
    final api = PhoneApi(_server);
    final sid = await _prepareReadyScenario();

    // the same lookups the UI does
    final info = await api.config();
    expect(info.backends.map((b) => b.id), contains('mock'));
    final scenarios = await api.listScenarios();
    final choice = scenarios.firstWhere((s) => s.id == sid);
    expect(choice.ready, [1]);
    expect(choice.title, isNotEmpty);

    final session = await api.createSession(scenarioId: sid, version: 1, runtime: {'decision_backend': 'mock'});
    expect(session.mockRealtime, isTrue);

    final logs = <String>[];
    WsConnection? conn;
    final sink = InstantAudioSink(duration: const Duration(milliseconds: 20));
    final client = PhoneClient(
      api: api,
      micSource: SilentAudioSource(),
      sink: sink,
      log: (l) {
        logs.add(l);
        // ignore: avoid_print
        print(l);
      },
      connector: (url, headers) async => conn = await IoWsConnection.connect(url, headers),
    );

    Future<void> waitLog(bool Function(String) pred, {int from = 0}) async {
      final end = DateTime.now().add(const Duration(seconds: 15));
      while (DateTime.now().isBefore(end)) {
        if (logs.skip(from).any(pred)) return;
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
      throw TimeoutException('log never matched; last: ${logs.isEmpty ? '-' : logs.last}');
    }

    void vad(Map<String, Object?> m) => conn!.sendText(jsonEncode({'type': 'mock_vad', ...m}));

    final running = client.run(session);
    final driver = () async {
      await waitLog((l) => l.contains('state LISTENING') && l.contains('node=select_need'));
      vad({'action': 'start', 'preview_branch': 'pricing', 'final_branch': 'demo'});
      await waitLog((l) => l.contains('preview pricing'));
      vad({'action': 'stop'});
      await waitLog((l) => l.contains('state LISTENING') && l.contains('node=confirm_demo'));
      vad({'action': 'start', 'final_branch': 'yes'});
      vad({'action': 'stop'});
    }();

    final result = await running.timeout(const Duration(seconds: 30));
    await driver;

    expect(result.finished, isTrue);
    expect(sink.played.length, 3, reason: 'select_need, confirm_demo, end_demo');
    expect(logs.where((l) => l.contains('▶ node:')).length, 3);
    expect(logs.any((l) => l.contains('finished FINISHED')), isTrue);
    expect(logs.any((l) => l.contains('FINAL demo')), isTrue);

    // the server saw our acks and client metrics
    final jsonl = await api.sessionLog(session.sessionId);
    expect(jsonl, contains('decision_message_to_playback_started_ms'));
    expect(jsonl, contains('client_metric'));
    api.close();
  }, skip: _server.isEmpty ? 'AUDIO_STROKE_SERVER is not set' : false, timeout: const Timeout(Duration(seconds: 90)));
}
