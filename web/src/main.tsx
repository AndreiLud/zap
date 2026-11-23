// Entry of the web client. The shell's styles load here; each page or area imports its own
// stylesheet from its component, so lazy pages bring their CSS with their chunk.

import { render } from 'preact';
import { boot } from './actions.ts';
import { App } from './app.tsx';
import './styles/tokens.css';
import './styles/base.css';
import './styles/header.css';
import './styles/pieces.css';

boot();
// A table address: start loading the table's code at once, in parallel with the room's connection.
if (new URLSearchParams(location.search).has('sala')) void import('./table/Table.tsx');
render(<App />, document.getElementById('app')!);
