/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { ClockIcon } from "@components/Icons";
import { useForceUpdater } from "@utils/react";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { Alerts, Checkbox, showToast, Slider, UploadHandler, useEffect, useState } from "@webpack/common";

const Native = VencordNative.pluginHelpers.VideoCompressor as PluginNative<typeof import("./native")>;
// Discord's upload limit for the current user, taking Nitro and server boosts into account
const getMaxFileSize: (guildId: string | null) => number = findByCodeLazy(".getUserMaxFileSize(", ".features.has(");

const MB = 1024 * 1024;

const settings = definePluginSettings({
    askEveryTime: {
        type: OptionType.BOOLEAN,
        description: "Ask how small to compress each video",
        default: true
    },
    targetSize: {
        type: OptionType.NUMBER,
        description: "Size to compress to when not asking, in MB. 0 uses your upload limit",
        default: 0
    }
});

function getLimit(guildId: string | null) {
    try { return getMaxFileSize(guildId); } catch { return 10 * MB; }
}

// Running compressions by file, shown next to the chat box and used to ignore duplicate drops
const jobs = new Map<string, { id: string; name: string; stage: string; progress: number; }>();
const listeners = new Set<() => void>();
const update = () => listeners.forEach(l => l());
const keyOf = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;
const isVideo = (f: File) => f.type.startsWith("video/") || /\.(mp4|m4v|mov|mkv|webm|avi)$/i.test(f.name);

async function compress(file: File, target: number) {
    const key = keyOf(file), id = Math.random().toString(36).slice(2);
    const job = { id, name: file.name, stage: "Reading video", progress: 0 };
    jobs.set(key, job);
    update();
    const poll = setInterval(async () => {
        Object.assign(job, await Native.getStatus(id));
        update();
    }, 1000);

    try {
        const result = await Native.compressVideo(new Uint8Array(await file.arrayBuffer()), target, id);
        if (typeof result === "string") throw new Error(result);
        return new File([result as BlobPart], file.name.replace(/\.\w+$/, "") + ".mp4", { type: "video/mp4" });
    } finally {
        clearInterval(poll);
        jobs.delete(key);
        update();
    }
}

function SizePicker({ limit, choice }: { limit: number; choice: { size: number; remember: boolean; }; }) {
    const [remember, setRemember] = useState(false);
    return (
        <>
            <Slider
                initialValue={choice.size} minValue={1} maxValue={limit} markers={[1, limit / 2, limit]} stickToMarkers={false}
                onValueChange={v => choice.size = v} onValueRender={v => `${v.toFixed(1)} MB`} onMarkerRender={v => `${Math.round(v)} MB`}
            />
            <Checkbox value={remember} type="inverted" onChange={(_, v) => { setRemember(v); choice.remember = v; }}>
                <span>Don't show again (use this size from now on)</span>
            </Checkbox>
        </>
    );
}

const ProgressButton: ChatBarButtonFactory = () => {
    const forceUpdate = useForceUpdater();
    useEffect(() => (listeners.add(forceUpdate), () => void listeners.delete(forceUpdate)), []);
    if (!jobs.size) return null;

    const active = [...jobs.values()];
    const percent = (p: number) => `${Math.floor(p * 100)}%`;
    const tooltip = active.map(j => `${j.stage} ${j.name}: ${percent(j.progress)}`).join(" • ") + " (click to cancel)";

    return (
        <ChatBarButton tooltip={tooltip} onClick={() => active.forEach(j => Native.cancel(j.id))}>
            <b style={{ fontSize: 12 }}>{percent(Math.min(...active.map(j => j.progress)))}</b>
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "VideoCompressor",
    description: "Automatically compresses videos that are over your upload limit so they fit",
    authors: [{ name: "Nikoloz", id: 0n }],
    settings,

    // Download ffmpeg in the background so it's ready by the first upload
    start: () => void Native.prepare().catch(() => { }),
    chatBarButton: { icon: ClockIcon, render: ProgressButton },

    patches: [{
        find: "Unexpected mismatch between files and file metadata",
        replacement: {
            // Discord shows its "file too large" popup here. Try compressing oversized videos first.
            // Discord skips this check for Nitro users and leaves it to the server, so check videos ourselves too
            match: /if\((\(0,\i\.\i\)\({files:(\i),guildId:(\i)}\))\)return void (\i\(\i,\i\))/,
            replace: "if($1||$self.overLimit($2,$3))return void $self.onTooLarge(arguments,$2,()=>$4)"
        }
    }],

    overLimit: (files: File[], guildId: string | null) => files.some(f => isVideo(f) && f.size > getLimit(guildId)),

    onTooLarge(args: IArguments, files: File[], showError: () => void) {
        const [, channel, draftType, options] = args as unknown as [File[], Channel, number, unknown];
        const limit = getLimit(channel.getGuildId());

        const big = files.filter(f => f.size > limit);
        if (!big.length || !big.every(isVideo)) return showError();
        if (big.some(f => jobs.has(keyOf(f)))) return showToast({ text: "Already compressing that video" });

        const run = (target: number) => {
            showToast({ text: "Compressing video, progress is shown next to the chat box" });
            Promise.all(files.map(f => isVideo(f) && f.size > target ? compress(f, target) : f))
                .then(out => (UploadHandler.promptToUpload as (...a: unknown[]) => void)(out, channel, draftType, options))
                .catch(e => e.message === "cancelled"
                    ? showToast({ text: "Compression cancelled" })
                    : showToast({ text: `Compression failed: ${e.message}`, variant: "critical", duration: 8000 }));
        };

        const limitMB = limit / MB;
        const savedMB = settings.store.targetSize > 0 ? Math.min(settings.store.targetSize, limitMB) : limitMB;
        if (!settings.store.askEveryTime) return run(savedMB * MB);

        const choice = { size: savedMB, remember: false };
        Alerts.show({
            title: "Compress video?",
            body: (
                <>
                    <p>{big.map(f => `${f.name} (${(f.size / MB).toFixed(0)} MB)`).join(", ")} is over your {limitMB.toFixed(0)} MB upload limit. Compress it to (smaller looks worse):</p>
                    <SizePicker limit={limitMB} choice={choice} />
                </>
            ),
            confirmText: "Compress",
            cancelText: "Cancel",
            onConfirm() {
                if (choice.remember) Object.assign(settings.store, { askEveryTime: false, targetSize: Math.round(choice.size * 10) / 10 });
                run(choice.size * MB);
            }
        });
    }
});
