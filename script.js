const stats = [
  { label: '本周产出', value: '246', unit: '小时', trend: '+12%', tone: 'up' },
  { label: '任务完成', value: '89%', unit: '达成率', trend: '+7%', tone: 'up' },
  { label: '学习复盘', value: '14', unit: '篇', trend: '3待更新', tone: 'mid' },
  { label: '坚持打卡', value: '26', unit: '天', trend: '+4%', tone: 'up' }
];

const tasks = [
  { title: '算法题训练', progress: 82, detail: '已完成 14 / 17 题' },
  { title: '项目文档整理', progress: 64, detail: '待补充部署说明' },
  { title: '晨间阅读计划', progress: 93, detail: '今日目标已达成' }
];

function renderStats() {
  const container = document.getElementById('stats-grid');
  if (!container) return;

  container.innerHTML = stats.map((stat) => `
    <article class="stat-card">
      <div class="label">
        <span>${stat.label}</span>
        <span class="status-pill ${stat.tone}">${stat.trend}</span>
      </div>
      <strong>${stat.value}</strong>
      <div class="label"><span>${stat.unit}</span><span>较上周</span></div>
    </article>
  `).join('');
}

function renderTasks() {
  const list = document.getElementById('task-list');
  if (!list) return;

  list.innerHTML = tasks.map((task) => `
    <li class="task-item">
      <div class="task-meta">
        <strong>${task.title}</strong>
        <small>${task.progress}%</small>
      </div>
      <div class="progress-track"><span style="width: ${task.progress}%"></span></div>
      <small>${task.detail}</small>
    </li>
  `).join('');
}

document.addEventListener('DOMContentLoaded', () => {
  document.title = '天道酬勤面板';
  renderStats();
  renderTasks();
});
