/**
 * Webpack config for the mermaid render probe — NOT part of the shipped build.
 *
 * Output goes to `.ado-code/probe-dist/`, which is gitignored and excluded from
 * the VSIX by `.vscodeignore`, so this chunk can never ship. The real build
 * (`webpack.config.js`) is untouched.
 *
 * Rebuild with:
 *   node C:/nvm4w/nodejs/node_modules/npm/bin/npm-cli.js --prefix src/webview-ui exec -- webpack --config webpack.probe.config.js
 *
 * Then run the Extension Development Host test:
 *   npm test -- --grep "mermaid renders"
 */

const path = require('path');

module.exports = {
  mode: 'production',
  entry: {
    'mermaid-probe': './src/probe/mermaidProbe.ts',
  },
  output: {
    path: path.resolve(__dirname, '../../.ado-code/probe-dist'),
    filename: '[name].js',
    // mermaid lazy-loads its diagram definitions; those chunks land beside the
    // entry and are fetched relative to it (`publicPath: 'auto'`).
    chunkFilename: '[id].js',
    publicPath: 'auto',
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  // A full mermaid copy with no compression is expected; the size warning is noise.
  performance: { hints: false },
};
