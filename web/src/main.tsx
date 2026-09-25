import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import 'pretendard/dist/web/variable/pretendardvariable.css';
import '@fontsource-variable/manrope';
import './styles.css';
import App from './App';

createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>);
