/**
 * 역할: 전역 스타일을 불러오고 HTML의 root 요소에 StrictMode로 감싼 React App을 렌더링한다.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
