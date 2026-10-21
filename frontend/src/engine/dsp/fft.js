// Radix-2 FFTs. `ComplexFFT` transforms in place; `RealFFT` computes the
// magnitude spectrum of a real frame using an N/2-point complex FFT.

export class ComplexFFT {
  constructor(n) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${n}`);
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
  }

  transform(re, im) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, tw = 0; k < half; k++, tw += step) {
          const a = start + k;
          const b = a + half;
          const wr = cos[tw];
          const wi = sin[tw];
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

export class RealFFT {
  constructor(n) {
    this.n = n;
    this.m = n / 2;
    this.inner = new ComplexFFT(this.m);
    this.re = new Float64Array(this.m);
    this.im = new Float64Array(this.m);
    this.cos = new Float64Array(this.m + 1);
    this.sin = new Float64Array(this.m + 1);
    for (let k = 0; k <= this.m; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / n);
      this.sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
  }

  // Writes |X[k]| for k = 0..n/2 into `out` (length n/2 + 1).
  magnitude(input, out) {
    const { m, re, im, cos, sin } = this;
    for (let i = 0; i < m; i++) {
      re[i] = input[2 * i];
      im[i] = input[2 * i + 1];
    }
    this.inner.transform(re, im);
    for (let k = 0; k <= m; k++) {
      const a = k % m;
      const b = (m - k) % m;
      // Split the packed transform into the spectra of even and odd samples.
      const er = (re[a] + re[b]) / 2;
      const ei = (im[a] - im[b]) / 2;
      const or = (im[a] + im[b]) / 2;
      const oi = -(re[a] - re[b]) / 2;
      const c = cos[k];
      const s = sin[k];
      const xr = er + c * or + s * oi;
      const xi = ei + c * oi - s * or;
      out[k] = Math.hypot(xr, xi);
    }
    return out;
  }
}
