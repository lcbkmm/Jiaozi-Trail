import { mountDigitalJiaozi } from './module.ts';
const root = document.getElementById('digital-jiaozi-root')!;
mountDigitalJiaozi(root).catch(error => {
  const section = document.createElement('section'); section.className = 'dj-app dj-fatal';
  const title = document.createElement('h1'); title.textContent = '暂时无法打开本地交子档案';
  const message = document.createElement('p'); message.textContent = error instanceof Error ? error.message : '本地存储不可用，记录未被覆盖。';
  const retry = document.createElement('button'); retry.className = 'dj-button'; retry.textContent = '重新打开'; retry.onclick = () => location.reload();
  section.append(title, message, retry); root.replaceChildren(section);
});
