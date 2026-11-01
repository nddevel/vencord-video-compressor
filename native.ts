/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChildProcess, execFile } from "child_process";
import { createHash } from "crypto";
import { app, IpcMainInvokeEvent } from "electron";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { gunzipSync } from "zlib";

// Static ffmpeg builds from github.com/eugeneware/ffmpeg-static, pinned by sha256 so a tampered download is never run
const RELEASE = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-";
const HASHES: Record<string, string> = {
    "linux-x64": "bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa",
    "linux-arm64": "754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0",
    "darwin-x64": "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
    "darwin-arm64": "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
    "win32-x64": "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77",
};

const status = new Map<string, { stage: string; progress: number; }>();
const running = new Map<string, ChildProcess>();
const cancelled = new Set<string>();
let ffmpegPath: Promise<string> | undefined;

function getFfmpeg() {
    return ffmpegPath ??= (async () => {
        const platform = `${process.platform}-${process.arch}`;
        const dir = join(app.getPath("userData"), "videoCompressor");
        const path = join(dir, platform.startsWith("win32") ? "ffmpeg.exe" : "ffmpeg");
        if (await stat(path).catch(() => null)) return path;

        if (!HASHES[platform]) throw new Error(`no ffmpeg build for ${platform}`);
        const res = await fetch(RELEASE + platform + ".gz");
        if (!res.ok) throw new Error(`ffmpeg download failed (${res.status})`);
        const gz = Buffer.from(await res.arrayBuffer());
        if (createHash("sha256").update(gz).digest("hex") !== HASHES[platform]) throw new Error("ffmpeg download was corrupted");

        await mkdir(dir, { recursive: true });
        await writeFile(path + ".tmp", gunzipSync(gz), { mode: 0o755 });
        await rename(path + ".tmp", path);
        return path;
    })().catch(e => { ffmpegPath = undefined; throw e; });
}

function run(id: string, ffmpeg: string, args: string[], cwd: string, onSeconds: (s: number) => void) {
    return new Promise<void>((resolve, reject) => {
        if (cancelled.has(id)) return reject(new Error("cancelled"));
        const child = execFile(ffmpeg, ["-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats", ...args], { cwd, maxBuffer: 1 << 26 },
            (err, _, stderr) => cancelled.has(id) ? reject(new Error("cancelled")) : err ? reject(new Error(stderr.trim().split("\n").at(-1) || err.message)) : resolve());
        running.set(id, child);
        child.stdout!.on("data", chunk => {
            const us = String(chunk).match(/out_time_us=(\d+)/)?.[1];
            if (us) onSeconds(Number(us) / 1e6);
        });
    });
}

export const prepare = (_: IpcMainInvokeEvent) => getFfmpeg().then(() => { });
export const getStatus = (_: IpcMainInvokeEvent, id: string) => status.get(id);
export function cancel(_: IpcMainInvokeEvent, id: string) {
    cancelled.add(id);
    running.get(id)?.kill();
}

// Resolves to the compressed mp4, or an error message
export async function compressVideo(_: IpcMainInvokeEvent, data: Uint8Array, target: number, id: string): Promise<Uint8Array | string> {
    const dir = await mkdtemp(join(tmpdir(), "vc-videocompressor-"));
    try {
        status.set(id, { stage: "Getting ffmpeg ready", progress: 0 });
        const ffmpeg = await getFfmpeg();
        const input = join(dir, "input"), output = join(dir, "output.mp4");
        await writeFile(input, data);

        // ffmpeg prints the video's info when given only an input
        const info = await new Promise<string>(r => execFile(ffmpeg, ["-hide_banner", "-i", input], (_, __, stderr) => r(stderr)));
        const [, h, m, s] = info.match(/Duration: (\d+):(\d+):([\d.]+)/) ?? [];
        const duration = Number(h) * 3600 + Number(m) * 60 + Number(s);
        if (cancelled.has(id)) return "cancelled";
        if (!duration) return "couldn't read the video's length";
        const fps = Math.min(Number(info.match(/([\d.]+) fps/)?.[1] ?? 30), 60);
        const hasAudio = /Stream #.*: Audio:/.test(info);

        // Reserve room for the MP4 index (~14 bytes per video and audio frame, adds up on long videos), plus 2% slack
        const budgetKbps = (outFps: number) => (target * 0.98 - 65536 - duration * (outFps + (hasAudio ? 47 : 0)) * 14) * 8 / 1000 / duration;
        const outFps = budgetKbps(fps) < 1200 ? Math.min(fps, 30) : fps;
        const total = budgetKbps(outFps);
        const audioKbps = !hasAudio ? 0 : total >= 1500 ? 128 : total >= 600 ? 96 : total >= 250 ? 64 : 48;
        let videoKbps = Math.floor(total - audioKbps);

        for (let attempt = 0; attempt < 2; attempt++) {
            if (videoKbps < 50) return "the video is too long to fit";

            // Lower bitrates look better at lower resolutions. The box fit also handles portrait videos
            const size = [[2500, 1920], [1200, 1280], [600, 854], [300, 640]].find(([kbps]) => videoKbps >= kbps)?.[1] ?? 426;
            const args = [
                "-y", "-i", input, "-map", "0:v:0",
                "-vf", `scale=w='min(iw,${size})':h='min(ih,${size})':force_original_aspect_ratio=decrease:force_divisible_by=2`,
                "-fpsmax", String(outFps), "-c:v", "libx264", "-b:v", `${videoKbps}k`, "-pix_fmt", "yuv420p", "-passlogfile", "pass"
            ];
            const audio = audioKbps ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", `${audioKbps}k`, "-ac", "2"] : ["-an"];

            const stage = attempt ? "Retrying, first try was slightly too big" : "Compressing";
            await run(id, ffmpeg, [...args, "-pass", "1", "-an", "-f", "null", "-"], dir, t => status.set(id, { stage, progress: t / duration / 2 }));
            await run(id, ffmpeg, [...args, "-pass", "2", ...audio, "-movflags", "+faststart", output], dir, t => status.set(id, { stage, progress: 0.5 + t / duration / 2 }));

            const result = await readFile(output);
            if (result.length <= target) return result;
            videoKbps = Math.floor(videoKbps - (result.length - target) * 8 / 1000 / duration * 1.2);
        }
        return "couldn't get the video under the size limit";
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    } finally {
        status.delete(id);
        running.delete(id);
        cancelled.delete(id);
        rm(dir, { recursive: true, force: true }).catch(() => { });
    }
}
