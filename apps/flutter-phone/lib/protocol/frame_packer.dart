import 'dart:typed_data';

/// First byte of every binary audio frame to the server (docs/API_EVENTS.md).
const int audioTag = 0x01;
const int targetSampleRate = 24000;

/// 20 ms of PCM16 mono at 24 kHz.
const int frameBytes = targetSampleRate ~/ 50 * 2;

/// Re-cuts arbitrary-length PCM16 mono input into 20 ms frames (960 bytes) tagged with
/// [audioTag]. Input at 48 kHz is decimated 2:1 (every other sample is kept) to 24 kHz.
class FramePacker {
  FramePacker({this.inputRate = targetSampleRate}) {
    if (inputRate != 24000 && inputRate != 48000) {
      throw ArgumentError.value(inputRate, 'inputRate', 'only 24000 or 48000 is supported');
    }
  }

  final int inputRate;

  final BytesBuilder _pending = BytesBuilder(copy: false);
  int _oddByte = -1; // low byte of a sample split across two chunks
  bool _keepNext = true; // decimation phase (48 kHz input): keep samples 0, 2, 4, …

  /// Bytes of PCM16 @ 24 kHz not yet emitted as a frame.
  int get pendingBytes => _pending.length;

  /// Feeds a chunk, returns zero or more ready frames (each 1 + 960 bytes).
  List<Uint8List> add(Uint8List chunk) {
    var data = chunk;
    if (_oddByte >= 0 && data.isNotEmpty) {
      final joined = Uint8List(data.length + 1)..[0] = _oddByte;
      joined.setRange(1, joined.length, data);
      data = joined;
      _oddByte = -1;
    }
    if (data.length.isOdd) {
      _oddByte = data.last;
      data = Uint8List.sublistView(data, 0, data.length - 1);
    }
    if (inputRate == 48000) {
      final samples = data.length ~/ 2;
      final out = BytesBuilder(copy: false);
      for (var i = 0; i < samples; i++) {
        if (_keepNext) out.add([data[2 * i], data[2 * i + 1]]);
        _keepNext = !_keepNext;
      }
      data = out.takeBytes();
    }
    if (data.isNotEmpty) _pending.add(data);

    final frames = <Uint8List>[];
    if (_pending.length >= frameBytes) {
      final all = _pending.takeBytes();
      var off = 0;
      while (all.length - off >= frameBytes) {
        final f = Uint8List(1 + frameBytes)..[0] = audioTag;
        f.setRange(1, 1 + frameBytes, all, off);
        frames.add(f);
        off += frameBytes;
      }
      if (off < all.length) _pending.add(Uint8List.sublistView(all, off));
    }
    return frames;
  }
}
