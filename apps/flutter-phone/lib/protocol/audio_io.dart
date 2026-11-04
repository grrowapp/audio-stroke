import 'dart:async';
import 'dart:typed_data';

/// Microphone side. Emits PCM16 little-endian mono chunks of arbitrary length.
abstract class AudioSource {
  /// 24000 (preferred) or 48000 (fallback; [FramePacker] decimates 2:1).
  int get sampleRate;

  Future<Stream<Uint8List>> start();

  Future<void> stop();
}

/// One playback in flight. Created by [AudioSink.start].
abstract class PlaybackHandle {
  /// Completes when sound actually starts coming out (not when the request was made).
  Future<void> get started;

  /// Completes when the audio played to its end. Completes with an error on failure.
  /// Never completes after [stop] was called.
  Future<void> get completed;

  /// Position in the audio in milliseconds (valid at any time, 0 before start).
  int get positionMs;

  /// Stops playback and returns the final position in ms.
  Future<int> stop();
}

/// Speaker side. [bytes] are a whole mp3 or wav file ([sniffAudioFormat]).
abstract class AudioSink {
  /// Hint from the server's `prefetch` message: [bytes] may be played soon.
  Future<void> prefetch(String audioId, Uint8List bytes);

  PlaybackHandle start(String audioId, Uint8List bytes);

  Future<void> dispose();
}

enum AudioFormat {
  wav('audio/wav'),
  mp3('audio/mpeg');

  const AudioFormat(this.mime);
  final String mime;
}

/// Same rule as cli/phone.ts: a RIFF header means wav, anything else is mp3.
AudioFormat sniffAudioFormat(Uint8List b) {
  if (b.length >= 4 && b[0] == 0x52 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x46) {
    return AudioFormat.wav;
  }
  return AudioFormat.mp3;
}

/// Emits 20 ms of digital silence every 20 ms. Used for MOCK sessions (the server does not
/// understand audio there, cli/phone.ts does the same) and for headless runs.
class SilentAudioSource implements AudioSource {
  SilentAudioSource({this.sampleRate = 24000});

  @override
  final int sampleRate;

  Timer? _timer;
  StreamController<Uint8List>? _c;

  @override
  Future<Stream<Uint8List>> start() async {
    final c = StreamController<Uint8List>();
    _c = c;
    final chunk = Uint8List(sampleRate ~/ 50 * 2);
    _timer = Timer.periodic(const Duration(milliseconds: 20), (_) {
      if (!c.isClosed) c.add(chunk);
    });
    return c.stream;
  }

  @override
  Future<void> stop() async {
    _timer?.cancel();
    _timer = null;
    await _c?.close();
    _c = null;
  }
}

/// Plays nothing: every playback "completes" after [duration]. For headless runs and tests.
class InstantAudioSink implements AudioSink {
  InstantAudioSink({this.duration = Duration.zero});

  final Duration duration;
  final List<String> played = [];
  final List<String> prefetched = [];

  @override
  Future<void> prefetch(String audioId, Uint8List bytes) async => prefetched.add(audioId);

  @override
  PlaybackHandle start(String audioId, Uint8List bytes) {
    played.add(audioId);
    return _InstantHandle(duration);
  }

  @override
  Future<void> dispose() async {}
}

class _InstantHandle implements PlaybackHandle {
  _InstantHandle(Duration d) {
    _completed = Future<void>.delayed(d).then((_) {
      if (_stopped) return Completer<void>().future;
    });
  }

  late final Future<void> _completed;
  bool _stopped = false;

  @override
  Future<void> get started => Future<void>.value();

  @override
  Future<void> get completed => _completed;

  @override
  int get positionMs => 0;

  @override
  Future<int> stop() async {
    _stopped = true;
    return 0;
  }
}
