/** Records drawing geometry, not pixels; real rasterization requires browser verification. */
export function canvasFactory(document) {
  const canvases = [];
  const createCanvas = () => {
    const canvas = document.createElement('canvas');
    const context = {
      canvas,
      draws: [],
      clipped: false,
      stack: [],
      filter: 'none',
      globalAlpha: 1,
      scaleX: 1,
      scaleY: 1,
      setTransform(a, b, c, d) {
        this.scaleX = a;
        this.scaleY = d;
      },
      scale(x, y) {
        this.scaleX *= x;
        this.scaleY *= y;
      },
      translate() {},
      beginPath() {},
      arc() {},
      ellipse() {},
      rect() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      fill() {},
      stroke() {},
      fillText() {},
      clip(rule) {
        this.clipped = rule !== 'evenodd';
        this.region = rule === 'evenodd' ? 'outside' : 'lens';
      },
      save() {
        this.stack.push({
          clipped: this.clipped,
          region: this.region,
          globalAlpha: this.globalAlpha,
          scaleX: this.scaleX,
          scaleY: this.scaleY,
        });
      },
      restore() {
        Object.assign(this, this.stack.pop());
      },
      clearRect() {
        this.draws = [];
      },
      fillRect() {},
      strokeRect() {},
      createLinearGradient() {
        return { addColorStop() {} };
      },
      createRadialGradient() {
        return { addColorStop() {} };
      },
      drawImage(source, x, y, width, height) {
        canvas.imageUrl = source.imageUrl ?? source.src;
        this.draws.push({
          source,
          x,
          y,
          width,
          height,
          clipped: this.clipped,
          region: this.region,
          scaleX: this.scaleX,
          scaleY: this.scaleY,
        });
      },
    };
    canvas.getContext = () => context;
    canvas.context = context;
    canvases.push(canvas);
    return canvas;
  };
  const requests = [];
  const loadImage = async (url) => {
    requests.push(url);
    return { src: url, width: 100, height: 100, naturalWidth: 100, naturalHeight: 100 };
  };
  return { createCanvas, loadImage, canvases, requests };
}
