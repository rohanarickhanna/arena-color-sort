# Are.na Color Sort

A Chrome extension that sorts any Are.na channel by color.

Open a channel on are.na and click **Sort by color** (bottom right). The channel opens in a full-screen view, re-sorted by each block's dominant color, with a ribbon of every block's color across the top.

- **Spectrum**: red through orange, yellow, green, blue, purple, pink, then grays from white to black
- **Light to dark**: by the whole image's lightness
- **Vivid to muted**: by how saturated the dominant color is
- **Channel order**: the original order, for comparison
- **Reverse** flips any of them. Keys `1` to `4` switch modes, `Esc` closes.

Text blocks and nested channels have no image, so they go to the end in their original order. Click a tile to open the block; click the ribbon to jump to a tile.

## Writing the order back

**Apply to channel** reorders the real channel to match the view. This needs an Are.na personal access token with write access (create one at are.na/settings/personal-access-tokens), and works on channels you own or collaborate on. The token is kept in this browser's extension storage and sent only to api.are.na.

Before the first move, the channel's current order is saved in the extension so **Restore original order** can put it back. Reordering is one API call per block (about 120 a minute on a free account), so keep the tab open while it runs.

## Install

1. `chrome://extensions`, turn on Developer mode
2. **Load unpacked**, pick the `extension/` folder

## How color is measured

Each image is fetched as a 32 by 32 thumbnail (Are.na's image CDN takes the size in the URL), clustered into 5 colors with k-means in OKLab, and the dominant color is the cluster with the highest area times saturation, so a red patch on a white page reads as red but a tiny accent does not. Below a chroma of 0.035 a block counts as gray. Results are cached per block.

## Develop

```
npm run check   # syntax check, manifest parse, unit tests
npm run zip     # package extension/ for the Chrome Web Store
```

No build step, no dependencies. `extension/color.js` is pure and tested under `node --test`; `extension/content.js` is the page UI.
