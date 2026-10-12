// Копирует pdf.js (рендер первой страницы PDF в браузере) из node_modules в public/vendor/pdfjs.
// Запуск: npm run vendor:pdfjs (результат лежит в репозитории, на Railway ничего собирать не нужно).
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist');
const dst = path.join(__dirname, '..', 'public', 'vendor', 'pdfjs');
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) fs.copyFileSync(path.join(src, 'build', f), path.join(dst, f));
// cmaps — для PDF с китайскими/японскими шрифтами без встроенных данных; standard_fonts — для стандартных шрифтов PDF
fs.cpSync(path.join(src, 'cmaps'), path.join(dst, 'cmaps'), { recursive: true });
fs.cpSync(path.join(src, 'standard_fonts'), path.join(dst, 'standard_fonts'), { recursive: true });
fs.copyFileSync(path.join(src, 'LICENSE'), path.join(dst, 'LICENSE'));
console.log('pdf.js copied to', path.relative(process.cwd(), dst));
