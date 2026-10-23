import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// Execute the real desktop methods, without a window or a user configuration.
function setup(enabled: boolean | undefined, sling = false) {
  let frames = 0;
  const throws: number[][] = [];
  const context = createContext({
    navigator: { platform: 'Win32' },
    performance: { now: () => 1000 },
    requestAnimationFrame: () => ++frames,
    cancelAnimationFrame: () => {},
    setTimeout: () => 0,
    window: { __dshPetDebug: {} },
    console,
    VIEW: { w: 1000, h: 800 },
    S: { estimateReleaseVelocity: () => ({ vx: 1800, vy: -400 }) },
  });
  runInContext(readFileSync(new URL('../../runtime/electron-helper/sprite.js', import.meta.url), 'utf8'), context);
  const PetSprite = runInContext('PetSprite', context);
  const sprite = Object.assign(Object.create(PetSprite.prototype), {
    pet: { dragPhysicsEnabled: enabled },
    pos: { x: 200, y: 180 },
    customPos: { rx: 0.25, ry: 0.26 },
    halfW: 50,
    halfH: 28,
    bottomPad: 0,
    dragState: { active: true, dragging: true, sling },
    dragFollow: null,
    dragFollowToken: 0,
    dragVel: { vx: 1200, vy: 400 },
    dragTarget: { x: 420, y: 260 },
    dragTrail: [
      { t: 900, x: 10, y: 10 },
      { t: 1000, x: 190, y: -30 },
    ],
    hit: { classList: { remove() {} } },
    stage: { style: {} },
    syncInputBusy() {},
    resumeWorkStatusAnim() {
      return true;
    },
    sendBounds(x: number, y: number) {
      this.pos = { x, y };
    },
    position() {
      this.pos = { x: this.customPos.rx * 1000 - 50, y: this.customPos.ry * 800 - 28 };
    },
    startThrow(...args: number[]) {
      throws.push(args);
    },
  });
  return { sprite, throws, frames: () => frames };
}

test('desktop direct dragging immediately follows its target with no scheduled motion', () => {
  const { sprite, frames } = setup(false);
  sprite.startDragFollow();
  assert.deepEqual(sprite.pos, { x: 420, y: 260 });
  assert.deepEqual({ ...sprite.dragVel }, { vx: 0, vy: 0 });
  assert.equal(frames(), 0);
});

for (const sling of [false, true]) {
  test(`desktop disabled inertia cannot launch a release (slingshot=${sling})`, () => {
    const { sprite, throws, frames } = setup(false, sling);
    sprite.startDragFollow();
    const before = { ...sprite.pos };
    sprite.onPointerUp();
    assert.deepEqual(sprite.pos, before);
    assert.equal(sprite.dragTrail.length, 0);
    assert.equal(throws.length, 0);
    assert.equal(frames(), 0);
    assert.equal(sprite.dragState.active, false);
  });
}

for (const enabled of [undefined, true]) {
  test(`desktop default/enabled inertia retains spring following and release launch (${enabled})`, () => {
    const { sprite, throws, frames } = setup(enabled);
    sprite.startDragFollow();
    assert.equal(frames(), 1);
    sprite.onPointerUp();
    assert.deepEqual(throws, [[200, 180, 1800, -400]]);
  });
}
