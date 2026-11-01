# VideoCompressor

A [Vencord](https://vencord.dev) plugin that shrinks videos that are too big to send on Discord.

## Why

Without Nitro, Discord only lets you upload 10 MB. Normally you'd have to open another app or website to compress a clip first, then go back and upload it. With this plugin you just drop the video in the chat and it gets compressed to fit.

## What it does

- Steps in when a video is over your upload limit
- Lets you pick how small the video should be. Tick "Don't show again" to always use that size
- Shows progress next to the chat box. Click it to cancel
- Puts the compressed video in your upload box, ready to send
- Leaves everything else alone. Other files and videos that already fit upload like normal

## How it works

1. You drop, paste or attach a video that's too big
2. Instead of Discord's "file too large" popup, you get a small window with a size slider
3. The plugin compresses the video on your computer with [ffmpeg](https://ffmpeg.org)
4. The smaller video shows up in your upload box. Press Enter to send it

Everything happens on your own computer. Your video isn't sent anywhere except to Discord when you send it.

## Upload limits

The plugin reads your limit straight from Discord, so you don't have to set anything.

| Account or server | Limit |
|---|---|
| Free | 10 MB |
| Nitro Basic, or a server at Boost level 2 | 50 MB |
| Server at Boost level 3 | 100 MB |
| Nitro | 500 MB |

## Install

You need Vencord built from source. See [installing custom plugins](https://docs.vencord.dev/installing/custom-plugins/).

```sh
cd Vencord/src/userplugins
git clone https://github.com/nddevel/vencord-video-compressor videoCompressor.desktop
cd ../.. && pnpm build
```

Keep the folder name `videoCompressor.desktop`. Then restart Discord and turn on **VideoCompressor** in Settings → Plugins.

Works in the Discord desktop app and Vesktop on Windows, macOS and Linux. It doesn't work in the browser.

You don't need to install ffmpeg. The first time the plugin starts, it downloads a copy (about 30 MB) from [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) and checks it against a fixed hash before using it.

## Settings

Found in Settings → Plugins → VideoCompressor.

- **Ask how small to compress each video:** turn this back on if you ticked "Don't show again"
- **Size to compress to:** the size used when the plugin doesn't ask. 0 means your upload limit

## Good to know

- **Smaller means worse quality.** The plugin lowers the resolution to keep the video watchable. A 1 minute clip at 10 MB stays at 720p, but a 10 minute video at 10 MB comes out at around 240p
- **It takes a while for long videos.** Compressing uses your CPU. Short clips take seconds, a 10 minute 4K video can take several minutes
- **Very long videos can't fit.** If there's not enough room, you'll get an error saying the video is too long

## Updating

```sh
cd Vencord/src/userplugins/videoCompressor.desktop
git pull
cd ../../.. && pnpm build
```

Then restart Discord.

## License

GPL-3.0, same as Vencord. ffmpeg is downloaded separately and has its own license.
