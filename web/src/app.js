import { rowsFor, filterRows, makeCsv, LIMITS } from './converter.js';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['file-input', 'dropzone', 'choose-files', 'queue', 'file-counter', 'convert', 'demo',
  'clear', 'dataset', 'dataset-help', 'delimiter', 'encoding', 'extras', 'protect', 'status', 'download',
  'row-count', 'result-description', 'table-tools', 'empty-result', 'table-wrap', 'table-head', 'table-body',
  'table-footer', 'file-filter', 'search', 'prev-page', 'next-page', 'page-info', 'page-label'].map(id => [id, $(id)]));
const files = [], PAGE_SIZE = 50;
let nextId = 1, busy = false, page = 0, view = { rows: [], columns: [] }, toastTimer;
let cachedDataKey = '', cachedData = null, cachedFilterKey = '', cachedRows = [];
function processFile(item, buffer) {
  return new Promise(resolve => {
    const worker = new Worker(new URL('./converter.worker.js', import.meta.url), { type: 'module' });
    const finish = value => { clearTimeout(timer); worker.terminate(); resolve(value); };
    const timer = setTimeout(() => finish({ error: { message: 'Обработка заняла больше минуты. Разделите документ или попробуйте XML-экспорт меньшего размера.' } }), 60000);
    worker.onmessage = ({ data }) => finish(data);
    worker.onerror = () => finish({ error: { message: 'Не удалось запустить обработчик. Обновите страницу и попробуйте файл меньшего размера.' } });
    worker.postMessage({ id: item.id, name: item.file.name, buffer }, [buffer]);
  });
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name); svg.append(use); return svg;
}
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
const count = n => new Intl.NumberFormat('ru-RU').format(n);
const size = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;

function message(text, type = '', action = null) {
  clearTimeout(toastTimer);
  const box = ui.status; box.replaceChildren(); box.className = 'status-banner ' + type;
  box.append(icon(type === 'error' || type === 'warning' ? 'info' : 'check'), el('span', '', text));
  if (action) { const button = el('button', '', action.label); button.type = 'button'; button.addEventListener('click', action.run); box.append(button); }
  box.hidden = !text;
}

function renderQueue() {
  ui.queue.replaceChildren(); ui['file-counter'].textContent = `${files.length} / 10`;
  ui.clear.hidden = !files.length; ui.clear.disabled = busy;
  for (const item of files) {
    const row = el('div', 'file-row'), mark = el('div', 'file-type'); mark.append(icon('file'));
    const info = el('div'); info.append(el('div', 'file-name', item.file.name));
    const meta = item.result?.container === 'GSDX / SDB5' ? `${size(item.file.size)} · ${count(item.result.records?.length || 0)} записей · ${count(item.result.indexedDescriptions || 0)} поисковых текстов · ${count(item.result.pages.length)} страниц` : item.result ? `${size(item.file.size)} · ${count(item.result.positions.length)} поз. · ${item.result.encoding.toUpperCase()}${item.demo ? ' · демонстрация' : ''}` : size(item.file.size);
    info.append(el('div', 'file-meta', meta));
    if (item.error) info.append(el('div', 'file-error', item.error));
    if (item.result?.warnings.length) info.append(el('div', 'file-warning', item.result.warnings.join(' ')));
    const labels = { pending: 'Ожидает', running: 'Обработка…', success: item.result?.catalog ? 'Частично' : item.result?.positions.length ? 'Готово' : 'XML-поля', error: 'Не прочитан' };
    const badge = el('span', 'file-badge ' + item.status, labels[item.status]);
    const remove = el('button', 'remove-file'); remove.type = 'button'; remove.setAttribute('aria-label', `Убрать файл ${item.file.name}`);
    remove.disabled = busy; remove.append(icon('close')); remove.addEventListener('click', () => {
      files.splice(files.indexOf(item), 1); page = 0; renderQueue(); refreshFileFilter(); renderResult();
      if (!files.length) message('');
    });
    row.append(mark, info, badge, remove); ui.queue.append(row);
  }
  const pending = files.filter(f => f.status === 'pending').length;
  ui.convert.replaceChildren(document.createTextNode(busy ? 'Преобразование…' : 'Преобразовать'), icon('arrow'));
  ui.convert.disabled = busy || !pending;
  ui.demo.disabled = busy;
}

function refreshFileFilter() {
  const previous = ui['file-filter'].value;
  ui['file-filter'].replaceChildren(new Option('Все преобразованные файлы', 'all'));
  for (const item of files.filter(f => f.result)) ui['file-filter'].append(new Option(item.file.name, String(item.id)));
  if ([...ui['file-filter'].options].some(o => o.value === previous)) ui['file-filter'].value = previous;
}

function renderResult() {
  const selected = ui['file-filter'].value;
  const results = files.filter(f => f.result && (selected === 'all' || String(f.id) === selected)).map(f => f.result);
  const mode = ui.dataset.value;
  ui.extras.disabled = mode !== 'positions';
  ui['dataset-help'].textContent = { records: 'Коды записей и слова из поискового индекса. Исходные названия, единицы и цены не декодированы.', positions: 'Коды, работы, объёмы и значения из сметы.', fields: 'Атрибуты и текстовые узлы XML; для GSDX — каталог, зоны и структура статей.', catalog: 'Сборники нормативной базы GSDX. Числовые расценки не извлекаются.', pages: 'Технические тексты GSDX: одна страница на строку, со ссылкой на источник.', blocks: 'Блоки GSDX, их смещения и статус: decoded / uninterpreted.' }[mode];
  ui.search.placeholder = mode === 'fields' ? 'Найти XML-путь, поле или значение…' : mode === 'records' ? 'Найти код или слова описания…' : 'Найти код или наименование…';
  const dataKey = JSON.stringify([mode, ui.extras.checked, selected, results.map(r => [r.sha256, r.name])]);
  if (dataKey !== cachedDataKey) { cachedDataKey = dataKey; cachedData = rowsFor(results, mode, ui.extras.checked); cachedFilterKey = ''; }
  const data = cachedData;
  const filterKey = dataKey + '|' + ui.search.value;
  if (filterKey !== cachedFilterKey) { cachedFilterKey = filterKey; cachedRows = filterRows(data.rows, ui.search.value, data.columns); }
  view = { columns: data.columns, rows: cachedRows };
  const totalPages = Math.max(1, Math.ceil(view.rows.length / PAGE_SIZE)); page = Math.min(page, totalPages - 1);
  const hasData = view.rows.length > 0;
  ui.download.disabled = !hasData || busy;
  ui['table-tools'].hidden = !results.length; ui['table-wrap'].hidden = !hasData;
  ui['table-footer'].hidden = !hasData; ui['empty-result'].hidden = hasData;
  const emptyTitle = ui['empty-result'].querySelector('h3'), emptyCopy = ui['empty-result'].querySelector('p');
  emptyTitle.textContent = results.length ? (data.rows.length ? 'Ничего не найдено' : 'В этом режиме нет строк') : 'Всё готово к вашим данным';
  emptyCopy.textContent = results.length ? (data.rows.length ? 'Измените поисковый запрос или выберите другой файл.' : 'Для GSDX выберите записи базы, каталог или технические тексты; для XML — «Все XML-поля». Другие типы файлов в выбранный режим не включаются.') : 'Выберите файлы выше или попробуйте конвертер на небольшом примере сметы.';
  ui['row-count'].textContent = results.length ? `${count(view.rows.length)} строк` : 'Нет данных';
  ui['result-description'].textContent = results.length ? `${count(results.length)} файл(а) · ${count(view.columns.length)} столбцов в CSV · значения без пересчёта` : 'Таблица появится после преобразования файлов.';
  const display = mode !== 'positions' ? view.columns : view.columns.filter(([key]) => ['file', 'chapter', 'number', 'code', 'name', 'unit', 'quantity', 'formula', 'basePZ', 'currentPZ'].includes(key));
  ui['table-head'].replaceChildren(); ui['table-body'].replaceChildren();
  if (!hasData) return;
  const head = el('tr'); for (const [, title] of display) head.append(el('th', '', title)); ui['table-head'].append(head);
  const start = page * PAGE_SIZE;
  for (const row of view.rows.slice(start, start + PAGE_SIZE)) {
    const tr = el('tr');
    for (const [key] of display) { const value = String(row[key] ?? ''); const td = el('td', ['name', 'value', 'text', 'searchText'].includes(key) ? 'wide-cell' : '', value || '—'); td.title = value; tr.append(td); }
    ui['table-body'].append(tr);
  }
  ui['page-info'].textContent = `Строки ${count(start + 1)}–${count(Math.min(start + PAGE_SIZE, view.rows.length))} из ${count(view.rows.length)}. CSV содержит все отфильтрованные строки.`;
  ui['page-label'].textContent = `${page + 1} / ${totalPages}`;
  ui['prev-page'].disabled = page === 0; ui['next-page'].disabled = page + 1 >= totalPages;
}

function addFiles(incoming, demo = false) {
  const added = [], problems = [];
  for (const file of incoming) {
    if (!/\.(gsf|gsfx|gsdx|xml)$/i.test(file.name)) { problems.push(`${file.name}: выберите GSF, GSFX, GSDX или XML.`); continue; }
    if (file.size > LIMITS.file) { problems.push(`${file.name}: файл больше 256 МиБ.`); continue; }
    if (!file.size) { problems.push(`${file.name}: файл пуст.`); continue; }
    if (files.length >= 10) { problems.push('Можно добавить не больше 10 файлов за один раз.'); break; }
    if (files.reduce((sum, f) => sum + f.file.size, 0) + file.size > LIMITS.total) { problems.push('Общий размер файлов ограничен 512 МиБ. Уберите часть файлов.'); break; }
    if (files.some(f => f.file.name === file.name && f.file.size === file.size && f.file.lastModified === file.lastModified)) continue;
    const item = { id: nextId++, file, demo, status: 'pending', result: null, error: null };
    files.push(item); added.push(item.id);
  }
  if (problems.length) message(problems.join(' '), 'warning');
  else if (added.length) message(demo ? 'Добавлен демонстрационный файл. Это искусственный пример, а не реальная смета.' : `Добавлено файлов: ${added.length}. Нажмите «Преобразовать».`);
  renderQueue(); refreshFileFilter(); renderResult(); return added;
}

async function processQueue(onlyIds = null) {
  if (busy) return;
  const pending = files.filter(f => f.status === 'pending' && (!onlyIds || onlyIds.includes(f.id)));
  if (!pending.length) return;
  busy = true; renderQueue(); renderResult(); let successes = 0;
  for (const item of pending) {
    item.status = 'running'; renderQueue(); message(`Обрабатывается: ${item.file.name}. Файл остаётся в браузере.`);
    try {
      const buffer = await item.file.arrayBuffer();
      const response = await processFile(item, buffer);
      if (response.error) throw new Error(response.error.message);
      item.result = response.result; item.status = 'success'; successes++;
    } catch (error) { item.status = 'error'; item.error = error.message || 'Не удалось прочитать файл.'; }
    renderQueue();
  }
  busy = false; page = 0; refreshFileFilter();
  if (!files.some(f => f.result?.positions.length) && files.some(f => f.result?.catalog) && ui.dataset.value === 'positions') ui.dataset.value = 'records';
  renderQueue(); renderResult();
  const noPositions = files.some(f => f.result) && !files.some(f => f.result?.positions.length);
  if (noPositions && ui.dataset.value === 'positions') message('Файлы прочитаны, но позиции локальной сметы не найдены. Можно выгрузить исходные XML-поля.', 'warning', { label: 'Показать XML-поля', run: () => { ui.dataset.value = 'fields'; page = 0; renderResult(); message('Выбран режим «Все XML-поля». Можно скачать CSV.'); } });
  else if (successes && pending.some(f => f.result?.container === 'GSDX / SDB5')) {
    const bases = pending.filter(f => f.result?.container === 'GSDX / SDB5');
    const rows = bases.reduce((sum, f) => sum + f.result.records.length, 0);
    const texts = bases.reduce((sum, f) => sum + f.result.indexedDescriptions, 0);
    message(`Частичная выгрузка GSDX: ${count(rows)} записей, ${count(texts)} поисковых текстов. Исходные названия, единицы, цены и расходы ресурсов не прочитаны.${rows ? ' Для поиска доступны коды и слова индекса.' : ' Доступны только метаданные; каталог можно выбрать отдельно.'}`, 'warning');
  }
  else if (successes) message(`Готово: ${successes} из ${pending.length} файл(а). Проверьте таблицу и скачайте CSV.${pending.some(f => f.demo) ? ' Пример содержит искусственные данные.' : ''}`, successes < pending.length ? 'warning' : '');
  else message('Файлы не удалось преобразовать. Причина указана под каждым файлом.', 'error');
}

ui['choose-files'].addEventListener('click', () => ui['file-input'].click());
ui['file-input'].addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
for (const event of ['dragenter', 'dragover']) ui.dropzone.addEventListener(event, e => { e.preventDefault(); ui.dropzone.classList.add('drag'); });
for (const event of ['dragleave', 'drop']) ui.dropzone.addEventListener(event, e => { e.preventDefault(); ui.dropzone.classList.remove('drag'); });
ui.dropzone.addEventListener('drop', e => addFiles([...e.dataTransfer.files]));
window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => e.preventDefault());
ui.convert.addEventListener('click', () => processQueue());
ui.clear.addEventListener('click', () => { if (busy) return; files.length = 0; ui.search.value = ''; page = 0; renderQueue(); refreshFileFilter(); renderResult(); message(''); });
ui.demo.addEventListener('click', async () => {
  if (busy) return;
  ui.demo.disabled = true;
  try {
    const response = await fetch('./examples/synthetic_estimate.gsfx');
    if (!response.ok) throw new Error('Не удалось загрузить пример. Попробуйте свой файл.');
    const file = new File([await response.arrayBuffer()], 'Пример_сметы.gsfx', { type: 'application/zip', lastModified: 1 });
    const ids = addFiles([file], true);
    if (ids.length) await processQueue(ids);
    else { const demo = files.find(f => f.demo); if (demo?.result) { ui['file-filter'].value = String(demo.id); renderResult(); message('Демонстрационный файл уже добавлен.'); } }
  } catch (error) { message(error.message, 'error'); }
  finally { ui.demo.disabled = busy; }
});
for (const key of ['dataset', 'extras', 'file-filter']) ui[key].addEventListener('change', () => { page = 0; renderResult(); });
let searchTimer; ui.search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { page = 0; renderResult(); }, 180); });
ui['prev-page'].addEventListener('click', () => { page--; renderResult(); });
ui['next-page'].addEventListener('click', () => { page++; renderResult(); });
ui.download.addEventListener('click', async () => {
  clearTimeout(searchTimer); renderResult();
  if (!view.rows.length || busy) return;
  const original = ui.download.textContent; ui.download.disabled = true; ui.download.textContent = 'Подготовка CSV…';
  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    const csv = makeCsv(view.rows, view.columns, { delimiter: ui.delimiter.value === 'tab' ? '\t' : ui.delimiter.value,
      bom: ui.encoding.value === 'bom', protect: ui.protect.checked });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url;
    const names = [...new Set(view.rows.map(row => row.file))];
    const stem = names.length === 1 ? names[0].replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') : 'grand_export';
    anchor.download = stem + (ui.dataset.value === 'positions' ? '' : '_' + ui.dataset.value) + '.csv';
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    message(`CSV подготовлен: ${count(view.rows.length)} строк, ${count(view.columns.length)} столбцов, ${size(blob.size)}.`);
  } catch (error) { message(error.message || 'Не удалось подготовить CSV.', 'error'); }
  finally { ui.download.replaceChildren(icon('download'), document.createTextNode(original.trim())); ui.download.disabled = !view.rows.length || busy; }
});

renderQueue(); renderResult();
