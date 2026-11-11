import '@fontsource-variable/inter';
import '@fontsource-variable/newsreader';
import '@fontsource-variable/jetbrains-mono';
import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app element');

const app = mount(App, { target });
export default app;
