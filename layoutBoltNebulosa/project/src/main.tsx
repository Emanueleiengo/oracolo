import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Easter egg: premendo insieme 6 e 7 compare un'esplosione nucleare
// (lo script sta in public/easter-egg.js)
const easterEgg = document.createElement('script');
easterEgg.src = `${import.meta.env.BASE_URL}easter-egg.js`;
document.body.appendChild(easterEgg);
