import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../tools/timeline/srt.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context, { filename: 'tools/timeline/srt.js' });
const { buildTimelineSrt, msToSrtTime, cleanSrtTitle } = context.TimelineSrt;

function cueList(srt) {
  return srt.trim().split(/\n\n/).map(block => block.split('\n'));
}

test('default 12-second SRT contains only numbered titles and correct cue timestamps', () => {
  const cues = cueList(buildTimelineSrt([
    { start: 0, duration: 213, title: '01. 冬をひらく音', trackNumber: 1 },
    { start: 213, duration: 279, title: '02. 折りたたんだ地図', trackNumber: 2 },
  ]));
  assert.equal(cues.length, 2);
  assert.deepEqual(Array.from(cues[0]), ['1', '00:00:00,000 --> 00:00:12,000', '01. 冬をひらく音']);
  assert.deepEqual(Array.from(cues[1]), ['2', '00:03:33,000 --> 00:03:45,000', '02. 折りたたんだ地図']);
});

test('12 through 15 seconds are supported, with 12 seconds as the default', () => {
  for (const seconds of [12, 13, 14, 15]) {
    const out = buildTimelineSrt([{ start: 0, duration: 180, title: 'Song', trackNumber: 1 }], seconds);
    assert.ok(out.includes(`00:00:00,000 --> 00:00:${seconds},000`));
  }
  assert.throws(() => buildTimelineSrt([{ start: 0, duration: 180, title: 'Song' }], 11), /12~15/);
  assert.throws(() => buildTimelineSrt([{ start: 0, duration: 180, title: 'Song' }], 16), /12~15/);
});

test('short tracks are clipped at their end and cannot overlap the next cue', () => {
  const cues = cueList(buildTimelineSrt([
    { start: 0, duration: 5, title: '01. First', trackNumber: 1 },
    { start: 5, duration: 3.5, title: '02. Second', trackNumber: 2 },
  ], 15));
  assert.equal(cues[0][1], '00:00:00,000 --> 00:00:05,000');
  assert.equal(cues[1][1], '00:00:05,000 --> 00:00:08,500');
});

test('repeat-rounds reset visible track numbers but retain unique cue IDs', () => {
  const cues = cueList(buildTimelineSrt([
    { start: 0, duration: 60, title: '01. First', trackNumber: 1 },
    { start: 60, duration: 60, title: '02. Second', trackNumber: 2 },
    { start: 120, duration: 60, title: '01. First', trackNumber: 1 },
    { start: 180, duration: 60, title: '02. Second', trackNumber: 2 },
  ]));
  assert.deepEqual(cues.map(c => c[0]), ['1','2','3','4']);
  assert.deepEqual(cues.map(c => c[2]), ['01. First','02. Second','01. First','02. Second']);
  assert.equal(cues[2][1], '00:02:00,000 --> 00:02:12,000');
});

test('start offset, gaps and hour/millisecond rollover are preserved', () => {
  const cues = cueList(buildTimelineSrt([
    { start: 3598.25, duration: 2, title: '1. First', trackNumber: 1 },
    { start: 3604.25, duration: 40, title: '2. Second', trackNumber: 2 },
  ], 12));
  assert.equal(cues[0][1], '00:59:58,250 --> 01:00:00,250');
  assert.equal(cues[1][1], '01:00:04,250 --> 01:00:16,250');
  assert.equal(msToSrtTime(3600012), '01:00:00,012');
});

test('no lyrics or localization suffixes are added; do not duplicate visible track numbers', () => {
  assert.equal(cleanSrtTitle('  (1)  夏の記憶   '), '夏の記憶');
  const out = buildTimelineSrt([
    { start: 0, duration: 60, title: '015. 橋の灯り', bracket: ' (다리의 빛)', titleKo: '다리의 빛', trackNumber: 15 },
  ]);
  assert.ok(out.includes('15. 橋の灯り'));
  assert.ok(!out.includes('015.'));
  assert.ok(!out.includes('다리의 빛'));
});

test('invalid timeline is rejected without creating misleading subtitle times', () => {
  assert.throws(() => buildTimelineSrt([]), /타임라인/);
  assert.throws(() => buildTimelineSrt([{ start: -1, duration: 10, title: 'X' }]), /올바르지/);
  assert.throws(() => buildTimelineSrt([{ start: 0, duration: 0, title: 'X' }]), /올바르지/);
});

test('timeline page offers automatic SRT generation and download controls', () => {
  const html = fs.readFileSync(new URL('../tools/timeline/index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="\.\/srt\.js"><\/script>/);
  assert.match(html, /id="srtSeconds"/);
  assert.match(html, /id="srtOutput"/);
  assert.match(html, /id="downloadSrtBtn"/);
  assert.match(html, /srtOutput\.value = globalThis\.TimelineSrt\.buildTimelineSrt\(generatedRows/);
  assert.match(html, /trackNumber: trackIndex \+ 1/);
  assert.match(html, /youtube_track_titles_\$\{seconds\}s\.srt/);
});
