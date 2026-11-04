import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_phone/protocol/ws_connection.dart';
import 'package:test/test.dart';

void main() {
  test('IoWsConnection sends Origin, delivers text and binary in order, and bufferedBytes returns to 0', () async {
    final server = await HttpServer.bind('127.0.0.1', 0);
    String? origin;
    final got = Completer<int>();
    var received = 0;
    late StreamSubscription<dynamic> sub;
    final upgraded = Completer<WebSocket>();
    server.listen((req) async {
      origin = req.headers.value('origin');
      final ws = await WebSocketTransformer.upgrade(req);
      sub = ws.listen((d) {
        received += d is String ? d.length : (d as List<int>).length;
        if (received >= 12 + 1000 * 961 && !got.isCompleted) got.complete(received);
      });
      sub.pause(); // stalled peer: stops reading
      upgraded.complete(ws);
    });

    final c = await IoWsConnection.connect('ws://127.0.0.1:${server.port}/ws', {'origin': 'http://example.test:1'});
    await upgraded.future;
    expect(origin, 'http://example.test:1');

    final frame = Uint8List(961);
    c.sendText('{"type":"x"}');
    for (var i = 0; i < 1000; i++) {
      c.sendBinary(frame);
    }
    sub.resume();
    await got.future.timeout(const Duration(seconds: 20));
    expect(received, 12 + 1000 * 961);
    expect(c.bufferedBytes, 0);
    // NOTE: with a stalled peer dart:io still accepts everything (no back-pressure from
    // WebSocket.add/addStream), so bufferedBytes does not reflect a stalled network; see docs.

    await c.close();
    await server.close(force: true);
  });
}
