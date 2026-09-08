import React from 'react';
import { createRoot } from 'react-dom/client';
import { ComponentGallery } from './gallery';

const root = document.getElementById('root');
const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.skin = query.get('theme') === 'dark' ? 'obsidian' : 'dawn';
document.documentElement.dataset.os = query.get('os') === 'mac' ? 'mac' : 'win';
if (root) createRoot(root).render(<ComponentGallery />);
