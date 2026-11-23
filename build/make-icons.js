/* Rasterize build/logo.svg into build/icon.png (1024) and build/icon.ico (256).
   Run with the bundled Electron: npx electron build/make-icons.js */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');

const SIZE = 1024;
const svgPath = path.join(__dirname, 'logo.svg');
const pngPath = path.join(__dirname, 'icon.png');
const icoPath = path.join(__dirname, 'icon.ico');

function svgMarkup() {
  const raw = fs.readFileSync(svgPath, 'utf8');
  return raw.replace(/width="512"/, 'width="' + SIZE + '"').replace(/height="512"/, 'height="' + SIZE + '"');
}

function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);
  entry.writeUInt8(0, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true }
  });
  win.webContents.setFrameRate(10);

  const html =
    '<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    'svg{display:block;width:' + SIZE + 'px;height:' + SIZE + 'px}</style></head><body>' +
    svgMarkup() +
    '</body></html>';
  fs.writeFileSync(path.join(__dirname, '.icon.html'), html, 'utf8');
  await win.loadFile(path.join(__dirname, '.icon.html'));
  await new Promise((resolve) => setTimeout(resolve, 700));

  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const png = image.toPNG();
  if (!png || png.length < 1000) {
    console.error('capture failed');
    app.exit(1);
    return;
  }
  fs.writeFileSync(pngPath, png);

  const small = nativeImage.createFromBuffer(png).resize({ width: 256, height: 256, quality: 'best' }).toPNG();
  fs.writeFileSync(icoPath, encodeIco(small));
  fs.unlinkSync(path.join(__dirname, '.icon.html'));

  const stats = {
    png: fs.statSync(pngPath).size,
    pngSize: nativeImage.createFromBuffer(png).getSize(),
    ico: fs.statSync(icoPath).size,
    icoSize: nativeImage.createFromBuffer(small).getSize()
  };
  fs.writeFileSync(path.join(__dirname, '.icon.json'), JSON.stringify(stats, null, 2));
  app.exit(0);
});
