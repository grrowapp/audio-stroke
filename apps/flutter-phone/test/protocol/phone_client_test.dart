import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_phone/protocol/api_client.dart';
import 'package:flutter_phone/protocol/audio_io.dart';
import 'package:flutter_phone/protocol/phone_client.dart';
import 'package:flutter_phone/protocol/ws_connection.dart';
import 'package:test/test.dart';

class FakeWs implements WsConnection {
  final incoming = StreamController<dynamic>();
  final sentText = <Map<String, dynamic>>[];
  final sentBinary = <Uint8List>[];
  @override
  int bufferedBytes = 0;
  bool open = true;

  @override
  Stream<dynamic> get messages => incoming.stream;
  @override
  bool get isOpen => open;
  @override
  void sendText(String s) => sentText.add(jsonDecode(s) as Map<String, dynamic>);
  @override
  void sendBinary(Uint8List b) => sentBinary.add(b);
  @override
  Future<void> close() async {
    open = false;
    if (!incoming.isClosed) await incoming.close();
  }

  void server(Map<String, Object?> m) => incoming.add(jsonEncode(m));
  List<Map<String, dynamic>> sent(String type) => sentText.where((m) => m['type'] == type).toList();
}

class FakeApi extends PhoneApi {
  FakeApi() : super('http://127.0.0.1:1');
  final fetched = <String>[];
  final failIds = <String>{};
  @override
  Future<Uint8List> fetchAudio(String audioId) async {
    fetched.add(audioId);
    if (failIds.contains(audioId)) throw ApiException('HTTP 404');
    return Uint8List.fromList([0x52, 0x49, 0x46, 0x46, 0]);
  }
}

class FakeHandle implements PlaybackHandle {
  FakeHandle(this.id);
  final String id;
  final startedC = Completer<void>();
  final completedC = Completer<void>();
  int pos = 0;
  bool stopped = false;
  @override
  Future<void> get started => startedC.future;
  @override
  Future<void> get completed => completedC.future;
  @override
  int get positionMs => pos;
  @override
  Future<int> stop() async {
    stopped = true;
    return pos;
  }
}

class FakeSink implements AudioSink {
  final handles = <FakeHandle>[];
  final prefetched = <String>[];
  @override
  Future<void> prefetch(String audioId, Uint8List bytes) async => prefetched.add(audioId);
  @override
  PlaybackHandle start(String audioId, Uint8List bytes) {
    final h = FakeHandle(audioId);
    handles.add(h);
    return h;
  }

  @override
  Future<void> dispose() async {}
}

class FakeMic implements AudioSource {
  FakeMic({this.sampleRate = 24000});
  @override
  final int sampleRate;
  final c = StreamController<Uint8List>();
  Object? startError;
  int stopCalls = 0;
  @override
  Future<Stream<Uint8List>> start() async {
    if (startError != null) throw startError!;
    return c.stream;
  }

  @override
  Future<void> stop() async => stopCalls++;
}

Future<void> pump() => Future<void>.delayed(const Duration(milliseconds: 5));

void main() {
  late FakeWs ws;
  late FakeApi api;
  late FakeSink sink;
  late FakeMic mic;
  late PhoneClient client;
  late List<String> logs;
  late Future<PhoneRunResult> running;
  var nowMs = 0;
  Map<String, String>? connectHeaders;
  String? connectUrl;

  Future<void> boot({bool mock = false, int micRate = 24000, int maxBacklog = 48000}) async {
    ws = FakeWs();
    api = FakeApi();
    sink = FakeSink();
    mic = FakeMic(sampleRate: micRate);
    logs = [];
    nowMs = 0;
    client = PhoneClient(
      api: api,
      micSource: mic,
      sink: sink,
      log: logs.add,
      connector: (url, headers) async {
        connectUrl = url;
        connectHeaders = headers;
        return ws;
      },
      clock: () => Duration(milliseconds: nowMs),
      maxBacklogBytes: maxBacklog,
      stopCloseDelay: Duration.zero,
    );
    running = client.run(SessionInfo({
      'session_id': 'ses_abc',
      'version': 1,
      'backend': 'mock',
      'mock_realtime': mock,
      'barge_in_enabled': false,
      'entry_audio_id': 'a' * 64,
    }));
    await pump();
  }

  Map<String, Object?> play(String pid, String audio, {String key = 'node:a'}) =>
      {'type': 'play', 'playback_id': pid, 'audio_id': audio, 'utterance_key': key, 'text': 'こんにちは', 'interruptible': false, 'turn_id': 1};

  test('connects with Origin header and session_id', () async {
    await boot();
    expect(connectUrl, 'ws://127.0.0.1:1/ws?session_id=ses_abc');
    expect(connectHeaders!['origin'], 'http://127.0.0.1:1');
    await ws.close();
    final r = await running;
    expect(r.finished, isFalse);
    expect(logs.last, contains('closed (connection dropped)'));
  });

  group('mic gate', () {
    test('frames are sent only while state.mic_enabled is true', () async {
      await boot();
      mic.c.add(Uint8List(960));
      await pump();
      expect(ws.sentBinary, isEmpty); // mic off by default
      ws.server({'type': 'state', 'phase': 'LISTENING', 'mic_enabled': true});
      await pump();
      mic.c.add(Uint8List(960 * 2 + 10));
      await pump();
      expect(ws.sentBinary.length, 2);
      expect(ws.sentBinary.first.length, 961);
      expect(ws.sentBinary.first[0], 0x01);
      ws.server({'type': 'state', 'phase': 'PLAYING', 'mic_enabled': false});
      await pump();
      mic.c.add(Uint8List(960));
      await pump();
      expect(ws.sentBinary.length, 2);
      await ws.close();
      await running;
    });

    test('48 kHz mic input is decimated to 24 kHz frames', () async {
      await boot(micRate: 48000);
      ws.server({'type': 'state', 'phase': 'LISTENING', 'mic_enabled': true});
      await pump();
      mic.c.add(Uint8List(1920));
      await pump();
      expect(ws.sentBinary.length, 1);
      expect(ws.sentBinary.single.length, 961);
      await ws.close();
      await running;
    });

    test('backlog above the limit sends stop once and drops frames', () async {
      await boot(maxBacklog: 1000);
      ws.server({'type': 'state', 'phase': 'LISTENING', 'mic_enabled': true});
      await pump();
      ws.bufferedBytes = 5000;
      mic.c.add(Uint8List(960 * 3));
      await pump();
      expect(ws.sentBinary, isEmpty);
      expect(ws.sent('stop').length, 1);
      await ws.close();
      await running;
    });

    test('MOCK session sends silence frames without touching the microphone', () async {
      await boot(mock: true);
      ws.server({'type': 'state', 'phase': 'LISTENING', 'mic_enabled': true});
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(ws.sentBinary, isNotEmpty);
      expect(ws.sentBinary.first.skip(1).every((b) => b == 0), isTrue);
      await ws.close();
      await running;
    });
  });

  group('playback acks and generations', () {
    test('play → started + client_metric → ended', () async {
      await boot();
      nowMs = 1000;
      ws.server(play('pb_1', 'b' * 64));
      await pump();
      expect(sink.handles.length, 1);
      expect(ws.sent('playback_started'), isEmpty); // not before sound actually starts
      nowMs = 1040;
      sink.handles[0].startedC.complete();
      await pump();
      expect(ws.sent('playback_started').single['playback_id'], 'pb_1');
      final m = ws.sent('client_metric').single;
      expect(m['name'], 'decision_message_to_playback_started_ms');
      expect(m['value_ms'], 40);
      expect(m['playback_id'], 'pb_1');
      sink.handles[0].completedC.complete();
      await pump();
      expect(ws.sent('playback_ended').single['playback_id'], 'pb_1');
      await ws.close();
      await running;
    });

    test('speech_stopped → playback_started also reports the notification metric', () async {
      await boot();
      nowMs = 500;
      ws.server({'type': 'speech_stopped'});
      await pump();
      nowMs = 700;
      ws.server(play('pb_1', 'b' * 64));
      await pump();
      nowMs = 760;
      sink.handles[0].startedC.complete();
      await pump();
      final names = ws.sent('client_metric').map((m) => m['name']).toList();
      expect(names, contains('client_notification_speech_stopped_to_playback_started_ms'));
      expect(ws.sent('client_metric').last['value_ms'], 260);
      await ws.close();
      await running;
    });

    test('a newer play supersedes the older one: stale completion sends no ack', () async {
      await boot();
      ws.server(play('pb_1', 'b' * 64));
      await pump();
      sink.handles[0].startedC.complete();
      await pump();
      ws.server(play('pb_2', 'c' * 64));
      await pump();
      expect(sink.handles[0].stopped, isTrue);
      sink.handles[1].startedC.complete();
      await pump();
      sink.handles[0].completedC.complete(); // late completion of the old generation
      await pump();
      expect(ws.sent('playback_ended'), isEmpty);
      expect(ws.sent('playback_canceled'), isEmpty); // superseding is silent, like phone.ts
      sink.handles[1].completedC.complete();
      await pump();
      expect(ws.sent('playback_ended').single['playback_id'], 'pb_2');
      expect(ws.sent('playback_started').map((m) => m['playback_id']), ['pb_1', 'pb_2']);
      await ws.close();
      await running;
    });

    test('playback_stop → playback_canceled with position_ms and reason barge_in', () async {
      await boot();
      ws.server(play('pb_1', 'b' * 64));
      await pump();
      sink.handles[0].startedC.complete();
      await pump();
      sink.handles[0].pos = 1234;
      ws.server({'type': 'playback_stop', 'playback_id': 'pb_1'});
      await pump();
      final c = ws.sent('playback_canceled').single;
      expect(c['playback_id'], 'pb_1');
      expect(c['reason'], 'barge_in');
      expect(c['position_ms'], 1234);
      expect(sink.handles[0].stopped, isTrue);
      sink.handles[0].completedC.complete();
      await pump();
      expect(ws.sent('playback_ended'), isEmpty);
      await ws.close();
      await running;
    });

    test('playback_stop for another playback_id is ignored', () async {
      await boot();
      ws.server(play('pb_2', 'b' * 64));
      await pump();
      sink.handles[0].startedC.complete();
      await pump();
      ws.server({'type': 'playback_stop', 'playback_id': 'pb_1'});
      await pump();
      expect(ws.sent('playback_canceled'), isEmpty);
      expect(sink.handles[0].stopped, isFalse);
      await ws.close();
      await running;
    });

    test('skip → playback_canceled reason user_skip', () async {
      await boot();
      ws.server(play('pb_1', 'b' * 64));
      await pump();
      sink.handles[0].startedC.complete();
      sink.handles[0].pos = 300;
      await pump();
      client.skip();
      await pump();
      final c = ws.sent('playback_canceled').single;
      expect(c['reason'], 'user_skip');
      expect(c['position_ms'], 300);
      await ws.close();
      await running;
    });

    test('audio fetch failure → playback_failed', () async {
      await boot();
      api.failIds.add('d' * 64);
      ws.server(play('pb_1', 'd' * 64));
      await pump();
      expect(ws.sent('playback_failed').single['playback_id'], 'pb_1');
      expect(sink.handles, isEmpty);
      await ws.close();
      await running;
    });

    test('sink error while playing → playback_failed', () async {
      await boot();
      ws.server(play('pb_1', 'b' * 64));
      await pump();
      sink.handles[0].startedC.complete();
      await pump();
      sink.handles[0].completedC.completeError(StateError('boom'));
      await pump();
      expect(ws.sent('playback_failed').single['error'], contains('boom'));
      await ws.close();
      await running;
    });
  });

  test('microphone start() failure after connect: error is rethrown and the WS is closed', () async {
    ws = FakeWs();
    mic = FakeMic()..startError = StateError('マイク権限がありません');
    final c = PhoneClient(
      api: FakeApi(),
      micSource: mic,
      sink: FakeSink(),
      log: (_) {},
      connector: (url, headers) async => ws,
    );
    await expectLater(
      c.run(SessionInfo({'session_id': 's', 'version': 1, 'backend': 'mock', 'entry_audio_id': 'a' * 64})),
      throwsA(isA<StateError>()),
    );
    expect(ws.open, isFalse, reason: 'server session must not stay connected');
    expect(mic.stopCalls, 1);
  });

  test('prefetch hint fetches audio and hands it to the sink', () async {
    await boot();
    ws.server({'type': 'prefetch', 'audio_ids': ['e' * 64, 'f' * 64]});
    await pump();
    expect(sink.prefetched, ['e' * 64, 'f' * 64]);
    await ws.close();
    await running;
  });

  test('finished is recorded; stop() sends stop and closes', () async {
    await boot();
    ws.server({'type': 'metric', 'name': 'x_ms', 'value_ms': 12});
    ws.server({'type': 'finished', 'phase': 'FINISHED', 'reason': 'completed'});
    await pump();
    client.stop();
    final r = await running;
    expect(r.finished, isTrue);
    expect(r.metrics['x_ms'], 12);
    expect(ws.sent('stop'), hasLength(1));
  });

  test('sniffAudioFormat: RIFF → wav, otherwise mp3', () {
    expect(sniffAudioFormat(Uint8List.fromList([0x52, 0x49, 0x46, 0x46, 1, 2])), AudioFormat.wav);
    expect(sniffAudioFormat(Uint8List.fromList([0xff, 0xfb, 0x90])), AudioFormat.mp3);
    expect(sniffAudioFormat(Uint8List(0)), AudioFormat.mp3);
  });
}
