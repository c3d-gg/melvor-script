/**
 * Prefixes absolute links with the site's base path, so pages can link to `/guides/combat/`
 * and still work when the site is served from https://c3d-gg.github.io/melvor-script/.
 * Handles Markdown links and `href` / `link` attributes on MDX components (LinkCard, LinkButton...).
 */
export default function remarkBase({ base }) {
  const prefix = base.replace(/\/$/, '');
  const fix = (url) =>
    typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.startsWith(`${prefix}/`)
      ? prefix + url
      : url;
  const walk = (node) => {
    if (node.type === 'link' || node.type === 'definition') node.url = fix(node.url);
    if ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && node.attributes) {
      for (const a of node.attributes)
        if (a.type === 'mdxJsxAttribute' && (a.name === 'href' || a.name === 'link')) a.value = fix(a.value);
    }
    if (node.children) node.children.forEach(walk);
  };
  return (tree) => {
    walk(tree);
  };
}
