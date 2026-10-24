// Captures mic audio in the 24 kHz AudioContext and posts PCM16 chunks (20 ms).
// Sending is gated by the main thread (enable/disable) — half-duplex playback
// keeps it disabled while assistant audio plays.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.chunk = new Int16Array(480);
    this.pos = 0;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.enabled === "boolean") {
        this.enabled = e.data.enabled;
        this.pos = 0; // never mix audio from before/after a gate change
      }
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (!this.enabled || !input || !input[0]) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      let s = ch[i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      this.chunk[this.pos++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.pos === this.chunk.length) {
        this.port.postMessage(this.chunk.buffer.slice(0));
        this.pos = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
