import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App kind={location.hash === '#little' ? 'little' : 'main'} />);
