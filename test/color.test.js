const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzePixels, sortItems, tinyImageUrl, rgbToOklab } = require('../extension/color.js');

// Build an RGBA buffer from [[r,g,b,count], ...]
function pixels(spec) {
  const out = [];
  for (const [r, g, b, n, a = 255] of spec) for (let i = 0; i < n; i++) out.push(r, g, b, a);
  return Uint8ClampedArray.from(out);
}
const solid = (r, g, b) => analyzePixels(pixels([[r, g, b, 64]]));

test('OKLab white and black', () => {
  const [Lw, aw, bw] = rgbToOklab(255, 255, 255);
  assert.ok(Math.abs(Lw - 1) < 1e-3 && Math.abs(aw) < 1e-3 && Math.abs(bw) < 1e-3);
  assert.ok(Math.abs(rgbToOklab(0, 0, 0)[0]) < 1e-6);
});

test('solid colors measure as themselves', () => {
  const red = solid(220, 30, 30);
  assert.deepEqual(red.rgb, [220, 30, 30]);
  assert.equal(red.neutral, false);
  assert.ok(red.h < 45 || red.h > 340, `red hue ${red.h}`);
  assert.equal(solid(128, 128, 128).neutral, true);
});

test('transparent pixels are ignored; fully transparent is null', () => {
  const c = analyzePixels(pixels([[0, 0, 255, 50], [255, 0, 0, 500, 0]]));
  assert.deepEqual(c.rgb, [0, 0, 255]);
  assert.equal(analyzePixels(pixels([[255, 0, 0, 10, 0]])), null);
});

test('a saturated patch beats a larger expanse of white', () => {
  const c = analyzePixels(pixels([[250, 250, 250, 700], [30, 90, 230, 300]]));
  assert.deepEqual(c.rgb, [30, 90, 230]);
  assert.equal(c.neutral, false);
  assert.equal(c.palette.length, 2);
  assert.ok(Math.abs(c.palette[0].weight - 0.7) < 1e-9);
});

test('a tiny accent on white stays neutral', () => {
  const c = analyzePixels(pixels([[250, 250, 250, 980], [230, 20, 20, 20]]));
  assert.equal(c.neutral, true);
});

test('spectrum sort runs red, orange, yellow, green, blue, purple, then neutrals light to dark', () => {
  const named = {
    black: [10, 10, 10], purple: [130, 50, 200], white: [245, 245, 245], green: [40, 170, 60],
    red: [220, 30, 30], blue: [30, 80, 220], yellow: [235, 210, 40], orange: [240, 130, 20], gray: [128, 128, 128],
  };
  const items = Object.entries(named).map(([name, c]) => ({ name, color: solid(...c) }));
  items.push({ name: 'text', color: null });
  const order = sortItems(items, 'spectrum').map((i) => i.name);
  assert.deepEqual(order, ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'white', 'gray', 'black', 'text']);
  const rev = sortItems(items, 'spectrum', true).map((i) => i.name);
  assert.equal(rev.at(-1), 'text', 'uncolored items stay last when reversed');
  assert.equal(rev[0], 'black');
});

test('light and vivid modes', () => {
  const items = [[20, 20, 20], [250, 250, 250], [230, 20, 20], [150, 120, 120]].map((c, i) => ({ i, color: solid(...c) }));
  assert.deepEqual(sortItems(items, 'light').map((x) => x.i), [1, 3, 2, 0]);
  assert.equal(sortItems(items, 'vivid')[0].i, 2);
});

test('tinyImageUrl rewrites images.are.na edits and rejects other hosts', () => {
  const payload = { bucket: 'arena_images', key: '1/original_x.jpg', edits: { resize: { width: 400 } } };
  const src = 'https://images.are.na/' + Buffer.from(JSON.stringify(payload)).toString('base64');
  const tiny = tinyImageUrl(src, 32);
  const back = JSON.parse(Buffer.from(tiny.split('/').pop(), 'base64').toString());
  assert.equal(back.key, '1/original_x.jpg');
  assert.deepEqual(back.edits.resize, { width: 32, height: 32, fit: 'fill' });
  assert.equal(tinyImageUrl('https://d2w9rnfcy7mm78.cloudfront.net/1/original_x.jpg'), null);
  assert.equal(tinyImageUrl('not a url'), null);
});

test('light mode ranks by whole-image lightness, not just the dominant color', () => {
  // Mostly black with a vivid yellow patch: dominant is yellow, image is dark.
  const darkWithYellow = { i: 'dark', color: analyzePixels(pixels([[10, 10, 10, 800], [240, 220, 30, 200]])) };
  const paleGray = { i: 'pale', color: analyzePixels(pixels([[200, 200, 200, 100]])) };
  assert.deepEqual(darkWithYellow.color.rgb, [240, 220, 30]);
  assert.deepEqual(sortItems([darkWithYellow, paleGray], 'light').map((x) => x.i), ['pale', 'dark']);
});

test('familyOf names common colors', () => {
  const { familyOf, familiesOf } = require('../extension/color.js');
  const cases = {
    red: [[220, 30, 30], [255, 0, 0], [220, 20, 60]],
    orange: [[255, 140, 0], [240, 130, 20]],
    yellow: [[255, 255, 0], [235, 210, 40]],
    green: [[0, 128, 0], [40, 170, 60], [128, 128, 0]],
    blue: [[0, 0, 255], [30, 80, 220], [0, 200, 220], [20, 30, 90]],
    purple: [[130, 50, 200], [128, 0, 128]],
    pink: [[255, 105, 180], [255, 192, 203], [255, 0, 255]],
    brown: [[139, 69, 19], [120, 90, 50]],
    white: [[250, 250, 250]], gray: [[128, 128, 128]], black: [[15, 15, 15]],
  };
  for (const [fam, list] of Object.entries(cases)) for (const c of list) assert.equal(familyOf(c), fam, `${c} -> ${familyOf(c)}`);
  const c = analyzePixels(pixels([[250, 250, 250, 600], [30, 90, 230, 300], [230, 30, 30, 100]]));
  assert.deepEqual(familiesOf(c).sort(), ['blue', 'white']);
});

test('distanceTo ranks a block containing the searched color first', () => {
  const { distanceTo, MATCH_DISTANCE } = require('../extension/color.js');
  const blueOnWhite = analyzePixels(pixels([[250, 250, 250, 700], [30, 80, 220, 300]]));
  const allRed = analyzePixels(pixels([[220, 30, 30, 1000]]));
  const target = [40, 90, 230];
  assert.ok(distanceTo(blueOnWhite, target) < MATCH_DISTANCE);
  assert.ok(distanceTo(allRed, target) > MATCH_DISTANCE);
  assert.equal(distanceTo(null, target), Infinity);
});
