'use strict';
const { app, BrowserWindow, Menu, dialog, net, protocol, session, shell } = require('electron');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { isAppUrl, assetForUrl, isAllowedExternal } = require('./security.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'grandcsv', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true
} }]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
let window;
function openExternal(url) {
  if (isAllowedExternal(url)) shell.openExternal(url).catch(() => {});
}
function about() {
  dialog.showMessageBox(window, { type: 'info', title: 'Grand CSV',
    message: `Grand CSV ${app.getVersion()}`,
    detail: 'Файлы обрабатываются на вашем компьютере. Python, Node.js, интернет и аккаунт ChatGPT для установленной версии не нужны.\n\nОткрытые GSFX/XML: позиции и исходные XML-поля. Старый двоичный GSF и Data.xml.crypt не поддерживаются.\n\nGSDX: только коды, поисковый индекс и доступные технические тексты. Полный экспорт исходных названий, единиц, цен и расхода ресурсов из GSDX НЕ реализован.', buttons: ['Понятно'] });
}
function menu() {
  const template = [];
  if (process.platform === 'darwin') template.push({ label: app.name, submenu: [
    { label: 'О Grand CSV и поддержке форматов', click: about }, { type: 'separator' },
    { role: 'hide', label: 'Скрыть Grand CSV' }, { role: 'hideOthers', label: 'Скрыть остальные' },
    { role: 'unhide', label: 'Показать все' }, { type: 'separator' }, { role: 'quit', label: 'Завершить Grand CSV' }
  ] });
  template.push({ label: 'Файл', submenu: [{ role: process.platform === 'darwin' ? 'close' : 'quit', label: process.platform === 'darwin' ? 'Закрыть окно' : 'Выход' }] },
    { label: 'Правка', submenu: [{ role: 'undo', label: 'Отменить' }, { role: 'redo', label: 'Повторить' },
      { type: 'separator' }, { role: 'cut', label: 'Вырезать' }, { role: 'copy', label: 'Копировать' },
      { role: 'paste', label: 'Вставить' }, { role: 'selectAll', label: 'Выбрать всё' }] },
    { label: 'Вид', submenu: [{ role: 'resetZoom', label: 'Исходный масштаб' }, { role: 'zoomIn', label: 'Увеличить' },
      { role: 'zoomOut', label: 'Уменьшить' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Полный экран' }] },
    { label: 'Справка', submenu: [{ label: 'О программе и ограничениях форматов', click: about },
      { label: 'Исходный код в GitHub', click: () => openExternal('https://github.com/edpik/grand-agent-parser') },
      { label: 'Релизы и инструкция установки', click: () => openExternal('https://github.com/edpik/grand-agent-parser/releases') }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
async function createWindow() {
  const uiRoot = app.isPackaged ? path.join(process.resourcesPath, 'ui') : path.join(__dirname, '..', 'web', 'dist');
  if (!existsSync(path.join(uiRoot, 'index.html'))) throw new Error('Не найдена сборка интерфейса. Для запуска из исходников выполните npm run build --prefix web.');
  const localSession = session.fromPartition('grandcsv-memory');
  if (!await localSession.protocol.isProtocolHandled('grandcsv')) {
    await localSession.protocol.handle('grandcsv', async request => {
      const asset = assetForUrl(request.url);
      if (!asset || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
      const response = await net.fetch(pathToFileURL(path.join(uiRoot, asset)).href, { bypassCustomProtocolHandlers: true });
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', CSP);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Cache-Control', 'no-store');
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
    });
    localSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    localSession.setPermissionCheckHandler(() => false);
    localSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAppUrl(details.url) && !details.url.startsWith('blob:') }));
    localSession.on('will-download', (_event, item) => {
      if (!item.getURL().startsWith('blob:') || !/\.csv$/i.test(item.getFilename())) { item.cancel(); return; }
      item.setSaveDialogOptions({ title: 'Сохранить CSV', buttonLabel: 'Сохранить',
        defaultPath: path.join(app.getPath('downloads'), item.getFilename()), filters: [{ name: 'CSV', extensions: ['csv'] }] });
    });
  }
  window = new BrowserWindow({ width: 1320, height: 900, minWidth: 760, minHeight: 600,
    title: 'Grand CSV — автономный конвертер', backgroundColor: '#f7f8fa', show: false,
    autoHideMenuBar: process.platform !== 'darwin', icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { session: localSession, nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false }
  });
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) { event.preventDefault(); openExternal(url); }
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = null; });
  await window.loadURL('grandcsv://app/index.html');
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => { menu(); await createWindow(); }).catch(error => {
    dialog.showErrorBox('Не удалось запустить Grand CSV', error.message); app.exit(1);
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(error => dialog.showErrorBox('Grand CSV', error.message)); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
