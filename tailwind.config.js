import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/client/**/*.{svelte,ts}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        paper: 'rgb(var(--paper-rgb) / <alpha-value>)',
        surface: 'rgb(var(--surface-rgb) / <alpha-value>)',
        raised: 'rgb(var(--raised-rgb) / <alpha-value>)',
        ink: 'rgb(var(--ink-rgb) / <alpha-value>)',
        muted: 'rgb(var(--muted-rgb) / <alpha-value>)',
        faint: 'rgb(var(--faint-rgb) / <alpha-value>)',
        line: 'rgb(var(--line-rgb) / <alpha-value>)',
        accent: 'rgb(var(--accent-rgb) / <alpha-value>)',
        'accent-soft': 'rgb(var(--accent-soft-rgb) / <alpha-value>)',
        positive: 'rgb(var(--positive-rgb) / <alpha-value>)',
        'positive-soft': 'rgb(var(--positive-soft-rgb) / <alpha-value>)',
        warning: 'rgb(var(--warning-rgb) / <alpha-value>)',
        'warning-soft': 'rgb(var(--warning-soft-rgb) / <alpha-value>)',
      },
      fontFamily: {
        display: ['Newsreader Variable', 'Iowan Old Style', 'Palatino Linotype', 'Georgia', 'serif'],
        sans: ['Inter Variable', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono Variable', 'Cascadia Code', 'Consolas', 'monospace'],
      },
      maxWidth: {
        column: '720px',
      },
      boxShadow: {
        card: '0 1px 2px rgb(30 25 18 / 0.05), 0 10px 30px -24px rgb(30 25 18 / 0.35)',
      },
    },
  },
  plugins: [],
} satisfies Config;
