# PINE liquidsoap source control script.
# The worker writes the playlist manifest into the shared control directory.
# Liquidsoap reads that file, plays it sequentially, and publishes the mount to Icecast.

set("log.stdout", true)
set("init.daemon", false)
settings.init.allow_root := true
set("server.telnet", true)
set("server.telnet.bind_addr", "0.0.0.0")
set("server.telnet.port", __LIQUIDSOAP_TELNET_PORT__)
set("frame.audio.samplerate", 44100)
set("frame.audio.channels", 2)

source_name = "__LIQUIDSOAP_SOURCE_NAME__"
icecast_host = "__ICECAST_HOST__"
icecast_port = int_of_string("__ICECAST_PORT__")
icecast_password = "__ICECAST_SOURCE_PASSWORD__"
icecast_mount = "__ICECAST_MOUNT__"
playlist_file = "/var/lib/liquidsoap/control/playlist.m3u"

# The worker keeps this file up to date as the single source of truth.
playlist_source = playlist(id="radio", mode="normal", reload_mode="watch", playlist_file)

# When the playlist is empty, keep the mount alive with silence.
radio = fallback(track_sensitive=false, [playlist_source, blank()])

output.icecast(
  %mp3(bitrate=128, stereo=true),
  host=icecast_host,
  port=icecast_port,
  user="source",
  password=icecast_password,
  mount=icecast_mount,
  name=source_name,
  description="PINE live station",
  genre="Radio",
  url="https://pine.local",
  radio
)
