cask "audio-stroke-phone" do
  version "0.1.0"
  sha256 "fbc2fdddf5123c3bee8dc525d462accad654c37de1d25f0c5306434d99ee1e39"

  url "https://github.com/grrowapp/audio-stroke/releases/download/phone-v#{version}/AudioStrokePhone-#{version}.zip"
  name "Audio Stroke Phone"
  desc "Conversation client for the Audio Stroke MVP server (mic and speaker via SoX)"
  homepage "https://github.com/grrowapp/audio-stroke"

  depends_on macos: ">= :ventura"
  depends_on formula: "node"
  depends_on formula: "sox"

  app "AudioStrokePhone.app"

  # Ad-hoc signed (no Apple developer certificate): drop the quarantine flag so Gatekeeper lets it open.
  postflight do
    system_command "/usr/bin/xattr", args: ["-cr", "#{appdir}/AudioStrokePhone.app"]
  end

  zap trash: [
    "~/.config/audio-stroke/phone.env",
    "~/.config/audio-stroke/phone.last",
    "~/Library/Logs/AudioStrokePhone",
  ]
end
