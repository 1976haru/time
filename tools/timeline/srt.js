/**
 * Creator Studio timeline title-only SRT generator.
 * Uses the exact time rows built for the YouTube description timeline.
 * No network/API/audio upload is required. Available in offline file:// mode.
 */
(function (root) {
  "use strict";

  function msToSrtTime(ms) {
    const total = Math.max(0, Math.round(Number(ms) || 0));
    const hours = Math.floor(total / 3600000);
    const minutes = Math.floor((total % 3600000) / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return [
      String(hours).padStart(2, "0"),
      String(minutes).padStart(2, "0"),
      String(seconds).padStart(2, "0"),
    ].join(":") + "," + String(millis).padStart(3, "0");
  }

  function cleanSrtTitle(rawTitle) {
    return String(rawTitle ?? "")
      .replace(/\s+/g, " ")
      .replace(/^\s*[\[(]?\d{1,3}[\])]?([\s._-]+|$)/, "")
      .trim();
  }

  function buildTimelineSrt(rows, displaySeconds = 12) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("SRT 자막을 만들 타임라인이 없습니다.");
    }
    const seconds = Number(displaySeconds);
    if (!Number.isInteger(seconds) || seconds < 12 || seconds > 15) {
      throw new Error("SRT 표시 시간은 12~15초 중에서 선택해 주세요.");
    }
    const cues = rows.map((row, index) => {
      const start = Number(row?.start);
      const duration = Number(row?.duration);
      const title = cleanSrtTitle(row?.title);
      const trackNumber = Number(row?.trackNumber ?? (index + 1));
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 ||
        !title || !Number.isInteger(trackNumber) || trackNumber < 1) {
        throw new Error(`타임라인 ${index + 1}번 곡의 시간 또는 제목이 올바르지 않습니다.`);
      }
      const startMs = Math.round(start * 1000);
      let endMs = Math.min(startMs + seconds * 1000, startMs + Math.round(duration * 1000));
      if (index + 1 < rows.length) {
        const nextStart = Number(rows[index + 1]?.start);
        if (Number.isFinite(nextStart)) endMs = Math.min(endMs, Math.round(nextStart * 1000));
      }
      if (endMs <= startMs) throw new Error(`타임라인 ${index + 1}번의 자막 길이를 확인해 주세요.`);
      const number = String(trackNumber).padStart(2, "0");
      return `${index + 1}\n${msToSrtTime(startMs)} --> ${msToSrtTime(endMs)}\n${number}. ${title}`;
    });
    return cues.join("\n\n") + "\n";
  }

  root.TimelineSrt = Object.freeze({ msToSrtTime, cleanSrtTitle, buildTimelineSrt });
})(typeof globalThis !== "undefined" ? globalThis : this);
