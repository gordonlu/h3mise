import type { AIService } from './ai.js';
import type { ProjectContext } from '../project-store.js';
import type {
  SkeletonRecommendation,
  SkeletonRecommendationResult,
  SkeletonSegment,
  SkeletonSegmentCount,
  StoryBeat,
  BeatApplyMode,
  BeatApplyResult,
  StorySkeleton,
} from '@h3mise/shared';
import { getStory } from './story.js';
import { applyBeatProposal } from './story-pipeline.js';

type Stage = Omit<SkeletonSegment, 'title'> & { title: string };

function variants(stages: Stage[]): StorySkeleton['variants'] {
  const build = (count: SkeletonSegmentCount): SkeletonSegment[] => Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * stages.length / count);
    const end = Math.max(start + 1, Math.floor((index + 1) * stages.length / count));
    const group = stages.slice(start, end);
    return {
      title: group.map((stage) => stage.title).join(' / '),
      purpose: group.map((stage) => stage.purpose).join('；'),
      tension: group.at(-1)?.tension ?? 'hold',
      question: group.map((stage) => stage.question).filter(Boolean).join('；'),
      category: group.at(-1)?.category ?? 'other',
    };
  });
  return { 3: build(3), 6: build(6), 9: build(9) };
}

const s = (title: string, purpose: string, tension: Stage['tension'], question: string, category: StoryBeat['category']): Stage =>
  ({ title, purpose, tension, question, category });

function skeleton(id: string, name: string, description: string, group: StorySkeleton['group'], tags: string[], stages: Stage[]): StorySkeleton {
  return { id, name, description, group, tags, variants: variants(stages) };
}

export const STORY_SKELETONS: StorySkeleton[] = [
  skeleton('three-beat-reversal', '三拍反转', '先建立明确预期，再强化它，最后用已埋下的信息翻转理解。', 'comedy', ['反转', '搞笑', '预期', '意外', '荒诞', '喜剧'], [
    s('异常钩子', '立即展示一个值得追问的异常', 'up', '观众第一秒会问什么？', 'setup'),
    s('正常解释', '角色给出看似可信的解释', 'hold', '为什么大家暂时相信？', 'setup'),
    s('强化预期', '第二个细节让原解释更可信', 'up', '怎样让观众押注错误答案？', 'rising_action'),
    s('微小破绽', '放入一个暂时不起眼的矛盾', 'up', '什么细节可在结尾回看？', 'rising_action'),
    s('错误行动', '角色依照错误理解采取行动', 'up', '错误理解造成什么选择？', 'rising_action'),
    s('假性确认', '结果似乎证明角色判断正确', 'hold', '如何制造短暂放心？', 'climax'),
    s('关键触发', '旧细节被一个动作重新激活', 'up', '哪个动作能触发真相？', 'climax'),
    s('意义翻转', '同一事实突然得到相反解释', 'release', '真相怎样既意外又合理？', 'resolution'),
    s('短促收尾', '用反应或动作追加最后一下', 'release', '谁的反应最好笑？', 'resolution'),
  ]),
  skeleton('misunderstanding-escalation', '误会升级', '一个模糊信号被连续误读，补救行为反而让误会越来越可信。', 'comedy', ['误会', '信息差', '喜剧', '尴尬', '关系', '谎言'], [
    s('模糊信号', '出现可以被两种方式理解的信息', 'up', '同一信号有哪些解释？', 'inciting_incident'),
    s('错误理解', '角色选择了更具冲突的解释', 'up', '为什么这个误解符合角色经验？', 'rising_action'),
    s('解释受阻', '合理原因让当事人无法立刻澄清', 'up', '什么阻止直接说清？', 'rising_action'),
    s('第一次补救', '角色试图修复但制造新证据', 'up', '补救为什么看起来更可疑？', 'rising_action'),
    s('旁观者介入', '第三方把误会传播或放大', 'up', '谁会误读得最严重？', 'rising_action'),
    s('关系最低点', '误会造成必须处理的具体后果', 'up', '最痛的代价是什么？', 'climax'),
    s('真相入口', '一个早已存在的事实终于可验证', 'hold', '证据此前藏在哪里？', 'climax'),
    s('连锁澄清', '多个误读依次被重新解释', 'release', '怎样快速回收伏笔？', 'falling_action'),
    s('余波笑点', '澄清后留下新的轻微尴尬', 'release', '谁仍然误会了一小部分？', 'resolution'),
  ]),
  skeleton('rules-out-of-control', '规则逐步失控', '一条简单规则被严格执行、钻空子或层层加码，最终产生荒谬新秩序。', 'comedy', ['规则', '失控', '职场', '学校', '荒诞', '制度'], [
    s('规则亮相', '展示一条简单且可理解的规则', 'hold', '规则原本解决什么？', 'setup'),
    s('小幅违规', '角色为了便利做出小小偏离', 'up', '第一个例外是什么？', 'inciting_incident'),
    s('严格执行', '另一角色机械执行规则', 'up', '谁从字面理解规则？', 'rising_action'),
    s('钻出漏洞', '角色发现规则允许荒谬替代方案', 'up', '怎样合法但离谱？', 'rising_action'),
    s('互相加码', '各方用更多规则压制对方', 'up', '谁会制定补丁规则？', 'rising_action'),
    s('系统堵塞', '规则开始妨碍原本目标', 'up', '具体什么事情无法完成？', 'climax'),
    s('公开崩溃', '最权威的执行者也被规则困住', 'hold', '规则怎样反噬制定者？', 'climax'),
    s('临时破局', '角色用最朴素方法绕开系统', 'release', '哪个常识解决了问题？', 'resolution'),
    s('新规则尾巴', '结尾暗示荒谬循环即将重来', 'up', '谁又贴出一条新通知？', 'resolution'),
  ]),
  skeleton('countdown-task', '倒计时任务', '目标和截止时间清晰可见，阻碍不断缩短选择空间，最后一刻兑现结果。', 'suspense', ['倒计时', '任务', '紧张', '比赛', '救援', '截止时间'], [
    s('目标与时限', '同时交代必须完成的目标和截止点', 'up', '失败会失去什么？', 'setup'),
    s('快速方案', '角色选择看起来最快的路径', 'hold', '为什么没有更稳的方法？', 'rising_action'),
    s('第一阻碍', '一个可解决的问题消耗时间', 'up', '阻碍怎样可视化时间流逝？', 'rising_action'),
    s('代价选择', '角色牺牲资源换取速度', 'up', '必须放弃什么？', 'rising_action'),
    s('方案失效', '原计划因新信息彻底不可用', 'up', '哪个假设被推翻？', 'climax'),
    s('最低余量', '只剩一次机会或一个动作', 'up', '最后机会是什么？', 'climax'),
    s('非常规尝试', '角色利用前面忽略的小资源', 'hold', '哪个伏笔能成为工具？', 'climax'),
    s('截止瞬间', '动作与倒计时同时结束', 'release', '结果如何在画面上立即可见？', 'resolution'),
    s('代价余波', '成功或失败留下具体后果', 'release', '角色为此付出了什么？', 'resolution'),
  ]),
  skeleton('information-gap', '信息差逼近', '观众掌握角色不知道的关键信息，看着危险或真相逐步逼近。', 'suspense', ['信息差', '悬疑', '秘密', '危险', '发现', '隐藏'], [
    s('先给观众答案', '让观众看到角色尚不知道的事实', 'up', '观众提前知道什么？', 'setup'),
    s('角色正常行动', '角色按错误认知继续目标', 'hold', '他的计划为何合理？', 'rising_action'),
    s('危险同框', '让未知事实进入角色附近', 'up', '怎样让观众看见距离缩短？', 'rising_action'),
    s('几乎发现', '角色接近真相却被打断', 'up', '谁或什么完成打断？', 'rising_action'),
    s('错误安心', '角色获得一个虚假的安全信号', 'hold', '为什么会放松警惕？', 'rising_action'),
    s('不可逆行动', '角色做出会触发后果的选择', 'up', '哪一步不能撤回？', 'climax'),
    s('真相露边', '关键信息第一次进入角色视野', 'up', '最先被看到的细节是什么？', 'climax'),
    s('完整发现', '角色重新理解此前所有信号', 'release', '哪些伏笔同时回收？', 'resolution'),
    s('新问题', '揭晓解决旧悬念但打开更大问题', 'up', '下一步最想知道什么？', 'resolution'),
  ]),
  skeleton('emotional-return', '情绪回收', '从疏离或冲突出发，通过克制的小动作完成关系变化，而不是强行说教。', 'emotion', ['温暖', '治愈', '亲情', '友情', '关系', '成长', '和解'], [
    s('关系温度', '用行为展示双方当前距离', 'hold', '什么动作能说明疏离？', 'setup'),
    s('未说出口', '角色隐藏一个真实需求', 'up', '他为什么不直接表达？', 'inciting_incident'),
    s('表层摩擦', '小事触发旧有关系模式', 'up', '争执表面在谈什么？', 'rising_action'),
    s('错过靠近', '一方尝试缓和但方式不对', 'up', '好意为何没被看见？', 'rising_action'),
    s('真实代价', '关系裂缝带来具体后果', 'up', '失去什么才意识到重要？', 'climax'),
    s('安静看见', '角色终于观察到对方未说的付出', 'hold', '哪个细节揭示真心？', 'climax'),
    s('小型选择', '角色放弃自尊或便利迈出一步', 'release', '他愿意承担什么？', 'falling_action'),
    s('动作回应', '另一方用对等动作接受变化', 'release', '不用台词如何回应？', 'resolution'),
    s('新的日常', '用轻微不同的日常证明关系改变', 'release', '开场动作如何被重新演绎？', 'resolution'),
  ]),
  skeleton('delayed-evidence', '证据延迟', '主角被错误归责，关键证据暂时无法出现；压力越高，最终澄清越有兑现感。', 'high_tension', ['误会', '冤枉', '证据', '打脸', '霸凌', '抢功', '陷害', '职场', '校园'], [
    s('不公钩子', '立即发生清晰的不公平事件', 'up', '观众为何立刻站队？', 'inciting_incident'),
    s('错误归责', '责任被可信地推到主角身上', 'up', '表面证据指向谁？', 'rising_action'),
    s('解释受阻', '主角因合理原因无法立刻自证', 'up', '关键证据为什么暂时不可用？', 'rising_action'),
    s('旁观倒向', '群体或重要人物接受错误说法', 'up', '谁的态度最让人难受？', 'rising_action'),
    s('越过底线', '对方利用优势进一步加码', 'up', '哪一步构成不可接受的越界？', 'climax'),
    s('假性胜利', '对方确信已经获胜并暴露更多问题', 'hold', '他会因得意说出什么事实？', 'climax'),
    s('第一证据', '提前埋下的信息重新出现', 'up', '哪条证据证明叙述有漏洞？', 'climax'),
    s('完整反转', '第二条事实锁定真实责任', 'release', '如何避免天降救兵？', 'resolution'),
    s('后果落地', '责任人承担与行为相称的具体后果', 'release', '失去资格、信任还是利益？', 'resolution'),
  ]),
  skeleton('power-misjudgment', '权力错判', '强势者依据表面身份轻视对方，逐步暴露自己，最终由真实能力或关系完成反转。', 'high_tension', ['身份', '看不起', '打脸', '权力', '阶层', '霸凌', '轻视', '逆袭'], [
    s('地位误判', '强势者根据表象快速给主角定级', 'up', '哪个表面信号导致误判？', 'inciting_incident'),
    s('小型刁难', '对方测试并公开展示优势', 'up', '第一次压制有什么具体代价？', 'rising_action'),
    s('克制原因', '说明主角暂不反击的可信原因', 'hold', '他在保护谁或等待什么？', 'rising_action'),
    s('能力暗示', '主角无意间展现不符合表象的细节', 'up', '什么细节让观众先意识到？', 'rising_action'),
    s('继续加码', '对方忽略警告并扩大冲突', 'up', '为什么他仍不收手？', 'rising_action'),
    s('公开最低点', '压制在重要见证者面前达到顶点', 'up', '公开场合为何重要？', 'climax'),
    s('真实关系进入', '前面埋下的人或事实自然抵达', 'hold', '如何证明不是巧合救场？', 'climax'),
    s('权力翻转', '众人重新理解双方真实位置', 'release', '反转由能力还是责任完成？', 'resolution'),
    s('克制兑现', '主角用行动决定对方后果', 'release', '怎样爽但不沦为叫骂？', 'resolution'),
  ]),
];

const KEYWORDS: Record<string, string[]> = {
  '误会': ['误解', '误会', '冤枉', '说不清'], '证据': ['证据', '录像', '录音', '证明', '真相'],
  '霸凌': ['霸凌', '欺负', '羞辱', '刁难', '压迫'], '打脸': ['打脸', '反击', '逆袭', '翻盘'],
  '职场': ['职场', '公司', '老板', '同事', '领导', '抢功'], '校园': ['校园', '学校', '同学', '老师'],
  '反转': ['反转', '意外', '没想到'], '搞笑': ['搞笑', '喜剧', '好笑', '荒诞'],
  '悬疑': ['悬疑', '秘密', '隐藏', '危险', '谜'], '倒计时': ['倒计时', '截止', '来不及', '最后一秒'],
  '温暖': ['温暖', '治愈', '感动', '亲情', '友情', '和解'], '规则': ['规则', '制度', '规定', '流程'],
  '身份': ['身份', '看不起', '阶层', '地位', '轻视'],
};

function expandedTerms(theme: string): Set<string> {
  const out = new Set(theme.toLowerCase().split(/[\s,，。；、:：!?！？]+/).filter(Boolean));
  for (const [tag, words] of Object.entries(KEYWORDS)) if (words.some((word) => theme.includes(word))) out.add(tag);
  return out;
}

export function localRecommendations(theme: string, limit = 3): SkeletonRecommendation[] {
  const terms = expandedTerms(theme);
  return STORY_SKELETONS.map((item, index) => {
    const hits = item.tags.filter((tag) => terms.has(tag) || [...terms].some((term) => tag.includes(term) || term.includes(tag)));
    const textHits = item.tags.filter((tag) => theme.includes(tag));
    const score = hits.length * 5 + textHits.length * 2 + Math.max(0, 1 - index / 100);
    return { skeleton: item, score, reason: hits.length ? `匹配：${[...new Set(hits)].join('、')}` : '内置通用节奏骨架' };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function recommendSkeletons(ai: AIService, theme: string): Promise<SkeletonRecommendationResult> {
  const local = localRecommendations(theme);
  if (!ai.model || !theme.trim()) return { mode: 'local', recommendations: local };
  try {
    const candidates = STORY_SKELETONS.map((item) => ({ id: item.id, name: item.name, description: item.description, tags: item.tags }));
    const result = await ai.model.structured<{ recommendations?: Array<{ skeletonId?: string; score?: number; reason?: string }> }>({
      system: '你是短视频叙事结构编辑。只能从候选骨架中选择，不得创造新 ID。根据主题的冲突、情绪曲线和预期结尾推荐最多 3 个。返回 JSON。',
      messages: [{ role: 'user', content: JSON.stringify({ theme, candidates, output: { recommendations: [{ skeletonId: 'existing-id', score: 0.9, reason: '简短理由' }] } }) }],
      json: true,
      temperature: 0.2,
    });
    const byId = new Map(STORY_SKELETONS.map((item) => [item.id, item]));
    const seen = new Set<string>();
    const recommendations = (result.recommendations ?? []).flatMap((item) => {
      const found = item.skeletonId ? byId.get(item.skeletonId) : null;
      if (!found || seen.has(found.id)) return [];
      seen.add(found.id);
      return [{ skeleton: found, score: Math.max(0, Math.min(1, Number(item.score) || 0.5)), reason: String(item.reason || 'AI 语义匹配') }];
    }).slice(0, 3);
    for (const item of local) if (recommendations.length < 3 && !seen.has(item.skeleton.id)) recommendations.push(item);
    return { mode: 'ai', recommendations };
  } catch {
    return { mode: 'local_fallback', recommendations: local };
  }
}

export function applySkeleton(p: ProjectContext, skeletonId: string, segmentCount: number, mode: BeatApplyMode = 'replace'): BeatApplyResult {
  const found = STORY_SKELETONS.find((item) => item.id === skeletonId);
  if (!found) throw new Error('story skeleton not found');
  if (segmentCount !== 3 && segmentCount !== 6 && segmentCount !== 9) throw new Error('segmentCount must be 3, 6, or 9');
  const story = getStory(p);
  const seconds = Math.max(2, Math.min(15, Math.round((story.plannedDurationSeconds || segmentCount * 5) / segmentCount)));
  return applyBeatProposal(p, found.variants[segmentCount].map((segment) => ({
    title: segment.title,
    category: segment.category,
    summary: `${segment.purpose}\n创作问题：${segment.question}`,
    notes: `叙事骨架：${found.name}；张力：${segment.tension}`,
    durationSeconds: seconds,
  })), { mode });
}
