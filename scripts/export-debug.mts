import { openRegistry } from '/data/code/H3Mise/server/src/project-store.ts';
import { Ffmpeg, FfmpegError } from '/data/code/H3Mise/server/src/ffmpeg.ts';
import { exportTimeline } from '/data/code/H3Mise/server/src/modules/timeline.ts';

const { store } = await openRegistry({ home: '/data/code/H3Mise/.h3mise-home' });
const projects = await store.list();
const p = await store.open(projects[0]!.id);
try {
  const res = await exportTimeline(p, new Ffmpeg(), 'direct-debug');
  console.log('OK:', res.relPath, res.durationSeconds);
} catch (e) {
  if (e instanceof FfmpegError) {
    console.log('FFMPEG STDERR:', e.stderr.split('\n').filter((l) => /error|invalid|duration|Output|frame=/i.test(l)).slice(-14).join('\n'));
  } else {
    console.log('ERR:', (e as Error).message);
  }
}
