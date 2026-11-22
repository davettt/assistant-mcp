// Telling an open app from a closed one by its main process in `ps -axo comm=` output.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listedAsRunning } from '../src/connection.js';

const dueAgain = { id: 'due-again', bundleName: 'Due Again' };
const lists = { id: 'lists-and-notes', bundleName: 'Lists & Notes' };

describe('listedAsRunning', () => {
  it('finds the main process wherever the bundle runs from', () => {
    for (const exe of [
      '/Applications/Due Again.app/Contents/MacOS/Due Again',
      '/Users/someone/Applications/Due Again.app/Contents/MacOS/Due Again',
      '/Volumes/Due Again 1.6.2/Due Again.app/Contents/MacOS/Due Again',
    ]) {
      assert.equal(listedAsRunning(dueAgain, `/sbin/launchd\n${exe}\n/usr/bin/ps\n`), true, exe);
    }
  });

  it('ignores helpers, other apps and a closed app', () => {
    const ps = [
      '/sbin/launchd',
      '/Applications/Due Again.app/Contents/Frameworks/Due Again Helper (Renderer).app/Contents/MacOS/Due Again Helper (Renderer)',
      '/Applications/Gift Keeper.app/Contents/MacOS/Gift Keeper',
      '/Applications/Not Due Again.app/Contents/MacOS/Not Due Again',
    ].join('\n');
    assert.equal(listedAsRunning(dueAgain, ps), false);
    assert.equal(listedAsRunning(lists, ps), false);
  });

  it('handles a bundle name with an ampersand', () => {
    const ps = '/Applications/Lists & Notes.app/Contents/MacOS/Lists & Notes\n';
    assert.equal(listedAsRunning(lists, ps), true);
  });
});
