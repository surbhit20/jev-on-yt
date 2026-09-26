// Keeps the video's own audio out of the mic while the user is talking, the way dictation apps
// pause media: 'pause' (default) pauses and later resumes a playing video, 'mute' mutes and
// restores the previous mute state, 'none' does nothing. The video element is injected.
export function createMediaGuard(getVideo, mode) {
  let saved = null;

  function engage() {
    if (saved || mode === 'none') return;
    const video = getVideo();
    if (!video) return;
    if (mode === 'mute') {
      saved = { video, muted: video.muted };
      video.muted = true;
    } else {
      saved = { video, paused: video.paused };
      if (!video.paused) video.pause();
    }
  }

  function release() {
    if (!saved) return;
    const { video } = saved;
    if ('muted' in saved) video.muted = saved.muted;
    else if (!saved.paused) video.play()?.catch?.(() => {});
    saved = null;
  }

  // The video changed: forget the old state without touching the new video.
  function reset() {
    saved = null;
  }

  return { engage, release, reset };
}
