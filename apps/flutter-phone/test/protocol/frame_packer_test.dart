import 'dart:typed_data';

import 'package:flutter_phone/protocol/frame_packer.dart';
import 'package:test/test.dart';

/// PCM16 LE bytes whose sample i has value (start + i).
Uint8List ramp(int start, int samples) {
  final b = ByteData(samples * 2);
  for (var i = 0; i < samples; i++) {
    b.setInt16(i * 2, start + i, Endian.little);
  }
  return b.buffer.asUint8List();
}

int sampleAt(Uint8List frame, int i) => ByteData.sublistView(frame).getInt16(1 + i * 2, Endian.little);

void main() {
  test('constants: 20 ms @ 24 kHz mono PCM16 = 960 bytes, tag 0x01', () {
    expect(frameBytes, 960);
    expect(audioTag, 1);
  });

  group('24 kHz input', () {
    test('re-cuts variable-length chunks into 961-byte tagged frames', () {
      final p = FramePacker();
      final all = ramp(0, 480 * 3 + 100); // 3 frames + 100 samples
      final frames = <Uint8List>[];
      var off = 0;
      for (final n in [10, 1000, 2, 700, 3000, all.length]) {
        final end = (off + n).clamp(0, all.length);
        frames.addAll(p.add(Uint8List.sublistView(all, off, end)));
        off = end;
        if (off >= all.length) break;
      }
      expect(frames.length, 3);
      for (final f in frames) {
        expect(f.length, 961);
        expect(f[0], 0x01);
      }
      for (var k = 0; k < 3; k++) {
        for (var i = 0; i < 480; i++) {
          expect(sampleAt(frames[k], i), k * 480 + i);
        }
      }
      expect(p.pendingBytes, 200);
    });

    test('odd byte counts keep sample alignment', () {
      final p = FramePacker();
      final all = ramp(100, 480);
      final frames = [
        ...p.add(Uint8List.sublistView(all, 0, 1)),
        ...p.add(Uint8List.sublistView(all, 1, 400)),
        ...p.add(Uint8List.sublistView(all, 400)),
      ];
      expect(frames.length, 1);
      for (var i = 0; i < 480; i++) {
        expect(sampleAt(frames[0], i), 100 + i);
      }
    });

    test('a short chunk yields nothing; exactly 960 bytes yields one frame', () {
      final p = FramePacker();
      expect(p.add(Uint8List(959)), isEmpty);
      expect(p.add(Uint8List(1)).length, 1);
    });
  });

  group('48 kHz input (2:1 decimation)', () {
    test('keeps every other sample: 960 samples @48k → one 480-sample frame', () {
      final p = FramePacker(inputRate: 48000);
      final frames = p.add(ramp(0, 960));
      expect(frames.length, 1);
      for (var i = 0; i < 480; i++) {
        expect(sampleAt(frames[0], i), 2 * i);
      }
    });

    test('decimation phase and odd bytes survive arbitrary chunking', () {
      final all = ramp(0, 1920); // 2 frames' worth
      final whole = FramePacker(inputRate: 48000).add(all);
      final p = FramePacker(inputRate: 48000);
      final split = <Uint8List>[];
      var off = 0;
      for (final n in [1, 3, 7, 501, 1001, 5000]) {
        final end = (off + n).clamp(0, all.length);
        split.addAll(p.add(Uint8List.sublistView(all, off, end)));
        off = end;
      }
      expect(split.length, 2);
      expect(whole.length, 2);
      for (var k = 0; k < 2; k++) {
        expect(split[k], whole[k]);
      }
      expect(sampleAt(split[1], 0), 960); // 480th kept sample = input sample 960
    });
  });

  test('unsupported input rate is rejected', () {
    expect(() => FramePacker(inputRate: 16000), throwsArgumentError);
  });
}
