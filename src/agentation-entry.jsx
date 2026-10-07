// Тулбар Agentation (визуальные комментарии для ИИ-агента). Собирается в public/vendor/agentation.js
// командой `npm run build:agentation` и подключается сервером только при AGENTATION=1.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Agentation } from 'agentation';

// Внутри iframe-страниц тулбар работает всегда; в оболочке (index) он скрывается,
// когда открыт инструмент (см. класс body.tool-open в index.ejs), чтобы не было двух тулбаров.
const mount = document.createElement('div');
document.body.appendChild(mount);
createRoot(mount).render(<Agentation className="agentation-host" appName="Business Service Platform" />);
