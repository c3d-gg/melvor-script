// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { unified } from '@astrojs/markdown-remark';
import remarkBase from './plugins/remark-base.mjs';

// Served from GitHub Pages at https://c3d-gg.github.io/melvor-script/. Pages link to each other
// with plain absolute paths (/guides/combat/); remark-base adds the /melvor-script prefix.
const site = 'https://c3d-gg.github.io';
const base = '/melvor-script';

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  // Starlight's asides, steps and tabs are remark plugins, so the Markdown processor is unified (remark).
  markdown: { processor: unified({ remarkPlugins: [[remarkBase, { base }]] }) },
  vite: { server: { fs: { allow: ['..'] } } },
  integrations: [
    starlight({
      title: 'Melvor Script',
      description: 'Play Melvor Idle by writing TypeScript.',
      logo: { src: './src/assets/logo.svg', replacesTitle: false },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/c3d-gg/melvor-script' }],
      editLink: { baseUrl: 'https://github.com/c3d-gg/melvor-script/edit/main/site/' },
      customCss: ['./src/styles/custom.css'],
      lastUpdated: false,
      expressiveCode: {
        themes: ['github-dark-default', 'github-light'],
        styleOverrides: { borderRadius: '0.5rem' },
        // Wrap long lines instead of scrolling sideways; wrapped lines keep their indent.
        defaultProps: { wrap: true, preserveIndent: true },
      },
      components: {
        // The reference is generated: "Edit page" should point at the doc comments instead.
        EditLink: './src/components/EditLink.astro',
      },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Quick start', slug: 'start/quick-start' },
            { label: 'How it works', slug: 'concepts/how-it-works' },
          ],
        },
        { label: 'Learn to code', items: [{ autogenerate: { directory: 'learn' } }] },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Reference', collapsed: false, items: [{ autogenerate: { directory: 'reference' } }] },
        {
          label: 'Project',
          items: [
            { label: 'Roadmap', slug: 'roadmap' },
            { label: 'Changelog', slug: 'changelog' },
          ],
        },
      ],
    }),
  ],
});
