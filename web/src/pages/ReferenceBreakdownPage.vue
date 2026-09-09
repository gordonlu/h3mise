<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { MediaAsset, ReferenceAnalysis, ReferenceBreakdown, Shot } from '@h3mise/shared';
import { fileUrl, get, mediaUrl, post, put } from '../api/client';
import { useToastStore } from '../stores/toast';

const route = useRoute();
const toasts = useToastStore();
const assetId = String(route.params.id);
const base = `/api/assets/media/${encodeURIComponent(assetId)}/breakdown`;
const doc = ref<ReferenceBreakdown | null>(null);
const shots = ref<Shot[]>([]);
const target = ref(String(route.query.shotId ?? ''));
const video = ref<HTMLVideoElement | null>(null);
const index = ref(0);
const time = ref(0);
const inPoint = ref(0);
const outPoint = ref(0);
const busy = ref('');
const error = ref('');
const aiEnabled = ref(false);
const analysis = ref<ReferenceAnalysis | null>(null);
const aiOpen = ref(false);
const cameraSuggestion = ref(false);
const use = ref<'motion' | 'camera' | 'composition' | 'general'>('motion');
const outputs = ref<MediaAsset[]>([]);
const selected = computed(() => doc.value?.segments[index.value]);
const cutCount = computed(() => doc.value?.cuts.filter(t => t > inPoint.value + 0.02 && t < outPoint.value - 0.02).length ?? 0);
const valid = computed(() => Number.isFinite(inPoint.value) && Number.isFinite(outPoint.value) && inPoint.value >= 0 && outPoint.value - inPoint.value >= 0.04 && outPoint.value <= (doc.value?.duration ?? 0));
const analysisCurrent = computed(() => analysis.value?.start === inPoint.value && analysis.value?.end === outPoint.value);
async function run(label: string, fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = label; error.value = '';
  try { await fn(); } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = ''; }
}
function seek(t: number) {
  if (!video.value || !doc.value) return;
  video.value.currentTime = Math.min(doc.value.duration - 0.001, Math.max(0, t));
  time.value = video.value.currentTime;
}
function select(i: number) {
  index.value = i;
  const s = selected.value;
  if (s) { inPoint.value = s.start; outPoint.value = s.end; seek(s.start); }
}
function tick() {
  time.value = video.value?.currentTime ?? 0;
  if (video.value && !video.value.paused && time.value >= outPoint.value) video.value.pause();
}
async function save(segments = doc.value!.segments) {
  doc.value = await put<ReferenceBreakdown>(base, { revision: doc.value!.revision, segments });
  analysis.value = null;
}
async function rangeSave() {
  if (!doc.value || !selected.value) return;
  const next = doc.value.segments.map(s => ({ ...s }));
  next[index.value] = { ...selected.value, start: inPoint.value, end: outPoint.value };
  await save(next);
}
async function split() {
  const s = selected.value;
  if (!doc.value || !s || time.value <= s.start + 0.04 || time.value >= s.end - 0.04) throw new Error('请将播放头移到当前片段内部');
  const next = [...doc.value.segments];
  next.splice(index.value, 1, { ...s, end: time.value }, { ...s, id: crypto.randomUUID(), start: time.value, label: `${s.label} B` });
  await save(next); select(index.value);
}
async function merge(offset: number) {
  if (!doc.value) return;
  const a = Math.min(index.value, index.value + offset);
  const next = [...doc.value.segments];
  if (!next[a] || !next[a + 1]) return;
  next.splice(a, 2, { ...next[a]!, end: next[a + 1]!.end });
  await save(next); select(a);
}
async function splitCuts() {
  if (!doc.value || !selected.value) return;
  const bounds = [inPoint.value, ...doc.value.cuts.filter(t => t > inPoint.value + 0.04 && t < outPoint.value - 0.04), outPoint.value];
  const next = [...doc.value.segments];
  next.splice(index.value, 1, ...bounds.slice(0, -1).map((start, i) => ({ id: crypto.randomUUID(), start, end: bounds[i + 1]!, label: `${selected.value!.label} · ${i + 1}` })));
  await save(next); select(index.value);
}
async function prepare(output: 'clip' | 'first' | 'last' | 'shot', bind = false) {
  const result = await post<{ assets: MediaAsset[]; shot: Shot | null }>(`${base}/prepare`, {
    start: inPoint.value, end: outPoint.value, output, use: use.value, ...(bind && target.value ? { shotId: target.value } : {}),
  });
  outputs.value = result.assets;
  if (result.shot) { target.value = result.shot.id; shots.value.push(result.shot); }
  toasts.push({ kind: 'ok', text: result.shot ? 'Shot 已创建；首尾帧已保存到素材库，可按需选择绑定。' : bind ? '参考已绑定；进入导演台检查生成模式与 Provider 支持。' : '已保存为新素材，原视频保留。' });
}
onMounted(() => run('读取视频与检测切镜…', async () => {
  const [data, list, status] = await Promise.all([post<ReferenceBreakdown>(base), get<Shot[]>('/api/shots'), get<{ configured: boolean }>('/api/ai/status')]);
  doc.value = data; shots.value = list; aiEnabled.value = status.configured; select(0);
  analysis.value = await get<ReferenceAnalysis | null>(`${base}/analysis`);
}));
</script>

<template>
  <main class="breakdown">
    <div class="crumb"><router-link to="/assets">素材库</router-link><span>/</span><span>参考拉片</span></div>
    <header class="heading"><div><h1>参考拉片</h1><p>选择一个连续镜头，提取导演方法，应用到自己的作品。</p></div><router-link v-if="target" :to="`/shots/${target}?tab=references`" class="button">进入导演台 →</router-link></header>
    <p v-if="busy" class="notice" role="status">{{ busy }}</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <div v-if="doc" class="workspace" :aria-busy="Boolean(busy)">
      <section class="viewer">
        <div class="screen"><video ref="video" :src="mediaUrl(assetId)" controls playsinline @timeupdate="tick" @loadedmetadata="seek(inPoint)" /></div>
        <div class="transport"><button :disabled="!doc.fps" title="按平均帧率步进；可变帧率视频为近似定位" @click="seek(time - 1 / (doc.fps ?? 25))">← 前一帧</button><button :disabled="!doc.fps" @click="seek(time + 1 / (doc.fps ?? 25))">后一帧 →</button><span>{{ time.toFixed(2) }} / {{ doc.duration.toFixed(2) }} s</span><button @click="inPoint = Number(time.toFixed(3))">设为 In</button><button @click="outPoint = Number(time.toFixed(3))">设为 Out</button></div>
        <input class="scrubber" aria-label="播放位置" type="range" min="0" :max="doc.duration" step="0.01" :value="time" @input="seek(Number(($event.target as HTMLInputElement).value))" />
        <div class="filmstrip"><button v-for="frame in doc.frames" :key="frame.relPath" :title="`${frame.timeSeconds.toFixed(2)} 秒`" @click="seek(frame.timeSeconds)"><img :src="fileUrl(frame.relPath)" alt="视频采样帧" /><span>{{ frame.timeSeconds.toFixed(1) }}s</span></button></div>
        <div class="segments"><button v-for="(s, i) in doc.segments" :key="s.id" :class="{ selected: i === index }" :disabled="Boolean(busy)" @click="select(i)"><strong>{{ s.label }}</strong><span>{{ s.start.toFixed(2) }} – {{ s.end.toFixed(2) }}s</span></button></div>
        <div class="editbar"><span>{{ doc.segments.length }} 个片段 · 切镜检测可手动修正</span><button :disabled="Boolean(busy)" @click="run('保存拆分…', split)">在此拆分</button><button :disabled="Boolean(busy) || index === 0" @click="run('保存合并…', () => merge(-1))">合并前段</button><button :disabled="Boolean(busy) || index === doc.segments.length - 1" @click="run('保存合并…', () => merge(1))">合并后段</button></div>
      </section>
      <aside class="prep">
        <h2>参考准备</h2><p class="muted">{{ selected?.label }} · 本地处理，无需 AI</p>
        <div class="ranges"><label>In / 秒<input v-model.number="inPoint" type="number" min="0" :max="doc.duration" step="0.01" /></label><label>Out / 秒<input v-model.number="outPoint" type="number" min="0" :max="doc.duration" step="0.01" /></label></div>
        <button :disabled="!valid || Boolean(busy)" @click="run('保存范围…', rangeSave)">保存片段范围</button>
        <dl><div><dt>时长</dt><dd>{{ (outPoint - inPoint).toFixed(2) }} s</dd></div><div><dt>切镜</dt><dd>{{ cutCount }}</dd></div><div><dt>平均帧率</dt><dd>{{ doc.fps?.toFixed(2) ?? '未知' }} FPS</dd></div><div><dt>分辨率</dt><dd>{{ doc.width }} × {{ doc.height }}</dd></div></dl>
        <div v-if="cutCount" class="notice">片段内仍有切镜，动作参考建议使用连续镜头。<button :disabled="!valid || Boolean(busy)" @click="run('按切镜拆分…', splitCuts)">按切镜拆分</button></div>
        <label>应用到 Shot<select v-model="target"><option value="">仅保存素材</option><option v-for="s in shots" :key="s.id" :value="s.id">{{ s.id }} · {{ s.title }}</option></select></label>
        <label>参考用途<select v-model="use"><option value="motion">动作与节奏</option><option value="camera">相机运动</option><option value="composition">构图参考</option><option value="general">通用视频参考</option></select></label>
        <p class="hint">保留所选导演方法，忽略原演员身份、服装与场景。视频能否用于生成由当前 Provider 和 Preflight 检查决定。</p>
        <button class="primary" :disabled="!valid || !target || Boolean(busy)" @click="run('裁剪并绑定参考…', () => prepare('clip', true))">裁剪并绑定参考</button>
        <div class="actions"><button :disabled="!valid || Boolean(busy)" @click="run('提取首帧…', () => prepare('first'))">提取首帧</button><button :disabled="!valid || Boolean(busy)" @click="run('提取尾帧…', () => prepare('last'))">提取尾帧</button><button :disabled="!valid || Boolean(busy)" @click="run('裁剪片段…', () => prepare('clip'))">仅裁剪素材</button><button :disabled="!valid || Boolean(busy)" @click="run('创建 Shot…', () => prepare('shot'))">创建 Shot</button></div>
        <div v-if="outputs.length" class="outputs"><strong>已生成素材</strong><a v-for="a in outputs" :key="a.id" :href="mediaUrl(a.id)" target="_blank" rel="noopener">{{ a.label }} ↗</a></div>
        <details :open="aiOpen" @toggle="aiOpen = ($event.target as HTMLDetailsElement).open"><summary>✦ AI 辅助分析 <small>可选</small></summary>
          <p class="hint">点击后将选定片段的 6 张采样帧发送到已配置的 AI。分析是建议，无法还原精确三维运动。</p>
          <p v-if="!aiEnabled" class="hint">未配置 AI。上方全部本地功能可正常使用。</p>
          <button :disabled="!aiEnabled || !valid || Boolean(busy)" @click="run('AI 分析选定镜头…', async () => { analysis = await post(`${base}/analyze`, { start: inPoint, end: outPoint }); })">分析选定镜头</button>
          <template v-if="analysis"><p v-if="!analysisCurrent" class="notice">范围已改变，请重新分析。</p><dl class="analysis"><div v-for="(label, key) in { action: '动作', camera: '运镜', shotSize: '景别', blocking: '调度', composition: '构图', screenDirection: '屏幕方向' }" :key="key"><dt>{{ label }}</dt><dd>{{ analysis.direction[key] || '未确定' }}</dd></div></dl><p v-for="(a, i) in analysis.direction.assessment" :key="i" class="hint">{{ a }}</p><div class="beatstrip"><span v-for="beat in analysis.direction.beats" :key="beat.id">{{ beat.label }} · {{ Math.round(beat.start * 100) }}–{{ Math.round(beat.end * 100) }}%</span></div><label class="check"><input v-model="cameraSuggestion" type="checkbox" />同时替换相机预演计划：{{ analysis.direction.cameraSuggestion }}</label><button class="primary" :disabled="!analysisCurrent || !target || Boolean(busy)" @click="run('应用导演方法…', async () => { await post(`${base}/apply`, { shotId: target, start: inPoint, end: outPoint, cameraPlan: cameraSuggestion }); toasts.push({ kind: 'ok', text: '已保存新导演计划版本；请重新编译 Prompt 并运行 Preflight。' }); })">提取导演方法并应用</button></template>
        </details>
      </aside>
    </div>
    <footer>下一步：进入导演台，选择自己的角色与场景，编译提示词并运行 Preflight。</footer>
  </main>
</template>

<style scoped>
.breakdown{max-width:1480px;margin:auto;padding:28px 36px 40px}.crumb{display:flex;gap:12px;color:var(--text-3);font-size:12px}.heading{display:flex;align-items:center;justify-content:space-between;margin:24px 0}.heading h1{font-family:var(--sans);font-size:28px;letter-spacing:-.8px;margin:0 0 8px}.heading p{margin:0;color:var(--text-3)}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start}.viewer{min-width:0}.screen{background:#14191c;border-radius:12px;overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:250px;aspect-ratio:16/9}.screen video{width:100%;height:100%;max-height:540px}.transport,.editbar{display:flex;align-items:center;gap:8px;padding:14px 0;flex-wrap:wrap}.transport span{font-variant-numeric:tabular-nums;margin-right:auto;color:var(--text-2)}.transport button,.editbar button{font-size:12px}.scrubber{width:100%;accent-color:var(--accent)}.filmstrip{display:flex;overflow:auto;border-radius:8px;margin:12px 0;gap:3px;background:var(--bg-3)}.filmstrip button{padding:0;position:relative;flex:0 0 100px;overflow:hidden;border:0;border-radius:0}.filmstrip img{width:100%;height:68px;object-fit:cover;display:block}.filmstrip span{position:absolute;bottom:3px;left:5px;color:white;font-size:10px;text-shadow:0 1px 3px black}.segments{display:flex;gap:8px;overflow:auto;padding:8px 0}.segments button{min-width:135px;display:grid;text-align:left;gap:6px;padding:12px 16px;background:var(--bg-2)}.segments span{font-size:11px;color:var(--text-3)}.segments .selected{border-color:var(--accent);background:var(--accent-soft);color:var(--accent-text)}.editbar{border-top:1px solid var(--line);margin-top:12px}.editbar>span{font-size:11px;color:var(--text-3);margin-right:auto}.prep{background:var(--bg-2);border:1px solid var(--line);border-radius:12px;padding:22px;display:grid;gap:14px}.prep h2{font-size:17px;margin:0}.prep p{margin:0}.prep label{display:grid;gap:7px;font-size:12px;color:var(--text-2)}.ranges,.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}.ranges input{width:100%;min-width:0}.prep select{width:100%}.prep dl{margin:0;display:grid;gap:10px;padding:12px 0;border-block:1px solid var(--line)}.prep dl>div{display:flex;justify-content:space-between;gap:15px}.prep dt{color:var(--text-3);font-size:12px}.prep dd{margin:0;font-variant-numeric:tabular-nums}.hint{font-size:11px;line-height:1.7;color:var(--text-3)}.notice{padding:12px;background:var(--accent-soft);border-radius:8px;font-size:12px;line-height:1.6}.notice.error{color:var(--bad);background:var(--bad-soft)}details{border-top:1px solid var(--line);padding-top:16px}summary{cursor:pointer;font-weight:600;display:flex;justify-content:space-between}details>*+*{margin-top:14px!important}small{color:var(--text-3);font-weight:400}.analysis>div{flex-direction:column;gap:5px!important}.analysis dd{font-size:12px;line-height:1.6}.check{display:flex!important;align-items:center}.outputs,.beatstrip{display:grid;gap:8px;font-size:11px}.outputs a{overflow-wrap:anywhere}footer{font-size:12px;color:var(--text-3);padding-top:24px}button:disabled{cursor:not-allowed;opacity:.45}
</style>
<style scoped>
.workspace{grid-template-columns:minmax(0,1fr) 340px}.screen{aspect-ratio:auto;height:420px;min-height:0}.screen video{object-fit:contain}.filmstrip{padding:0}.filmstrip::before,.filmstrip::after{display:none}.heading{margin:18px 0}.heading h1{line-height:1.3}.prep{gap:12px}.prep .hint{font-size:12px}.prep dl{gap:8px}.prep .primary{min-height:38px}.breakdown{padding-top:22px}.heading>.button{white-space:nowrap}
</style>
