import 'dart:async';
import 'dart:collection';
import 'dart:io';
import 'dart:typed_data';

/// Minimal WebSocket surface the protocol layer needs, so tests can fake it.
abstract class WsConnection {
  /// Incoming messages: [String] (JSON) or [List<int>] (binary).
  Stream<dynamic> get messages;

  bool get isOpen;

  /// Bytes handed to [sendText]/[sendBinary] that the socket has not accepted yet
  /// (the equivalent of the browser's `bufferedAmount`).
  int get bufferedBytes;

  void sendText(String s);

  void sendBinary(Uint8List b);

  Future<void> close();
}

typedef WsConnector = Future<WsConnection> Function(String url, Map<String, String> headers);

/// dart:io WebSocket with an Origin header (which `WebSocket.connect(headers:)` allows).
///
/// dart:io has no `bufferedAmount`, and `WebSocket.add` buffers without limit, so a stalled
/// connection would never be noticed. Messages are therefore written one at a time with
/// `addStream` (whose future completes once the socket accepted the message); everything not yet
/// accepted is counted in [bufferedBytes].
///
/// Known limit (measured on the Dart VM, see test/protocol/ws_connection_test.dart): against a
/// peer that stops reading, dart:io still accepts 30 MB without waiting, so [bufferedBytes] stays
/// near 0 and the "> 1 s backlog → stop" guard of cli/phone.ts is effectively inactive here.
class IoWsConnection implements WsConnection {
  IoWsConnection._(this._ws);

  static Future<WsConnection> connect(String url, Map<String, String> headers) async {
    final ws = await WebSocket.connect(url, headers: headers);
    return IoWsConnection._(ws);
  }

  final WebSocket _ws;
  final Queue<Object> _queue = Queue<Object>();
  bool _pumping = false;
  bool _closing = false;
  int _buffered = 0;

  @override
  Stream<dynamic> get messages => _ws;

  @override
  bool get isOpen => _ws.readyState == WebSocket.open && !_closing;

  @override
  int get bufferedBytes => _buffered;

  static int _size(Object e) => e is String ? e.length : (e as List<int>).length;

  void _enqueue(Object e) {
    if (!isOpen) return;
    _buffered += _size(e);
    _queue.add(e);
    if (!_pumping) unawaited(_pump());
  }

  Future<void> _pump() async {
    _pumping = true;
    try {
      while (_queue.isNotEmpty) {
        final e = _queue.removeFirst();
        try {
          await _ws.addStream(Stream<Object>.value(e));
        } catch (_) {
          _queue.clear();
          _buffered = 0;
          return;
        }
        _buffered -= _size(e);
      }
    } finally {
      _pumping = false;
    }
  }

  @override
  void sendText(String s) => _enqueue(s);

  @override
  void sendBinary(Uint8List b) => _enqueue(b);

  @override
  Future<void> close() async {
    _closing = true;
    final end = DateTime.now().add(const Duration(seconds: 2));
    while (_pumping && DateTime.now().isBefore(end)) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    await _ws.close(WebSocketStatus.normalClosure).timeout(const Duration(seconds: 2), onTimeout: () {});
  }
}
