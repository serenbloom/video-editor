/**
 * Pure ffmpeg filter_complex builder for the Reel Cutter export pipeline.
 * No DOM / browser APIs here so this file can be loaded both as a plain
 * <script> in the browser (exposes window.FilterGraph) and with require()
 * from Node for automated testing (module.exports.FilterGraph).
 */
(function (root) {
  'use strict';

  function num(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '0';
    var r = Math.round(n * 1000) / 1000;
    if (Object.is(r, -0)) r = 0;
    return String(r);
  }

  /**
   * Computes the pixel Y baseline for each wrapped line of a caption.
   * We resolve this ourselves (rather than relying on ffmpeg's multiline
   * `text_h`/centering, which was found to mis-measure multi-line CJK text)
   * because the output height is known exactly at build time.
   */
  function lineYPositions(position, outputHeight, fontsize, lineCount) {
    var lineHeight = Math.round(fontsize * 1.3);
    var totalHeight = lineHeight * lineCount;
    var margin = Math.round(outputHeight * 0.08);
    var startY;
    if (position === 'top') startY = margin;
    else if (position === 'center') startY = Math.round((outputHeight - totalHeight) / 2);
    else startY = outputHeight - margin - totalHeight; // bottom (default)
    var ys = [];
    for (var i = 0; i < lineCount; i++) ys.push(startY + i * lineHeight);
    return ys;
  }

  /**
   * @param {Object} p
   * @param {number} p.width  output width in px
   * @param {number} p.height output height in px
   * @param {number} p.fps    output frame rate
   * @param {string} p.fontFile path (inside ffmpeg's virtual FS) to a font usable by drawtext
   * @param {Array}  p.sequence [{inputIndex, in, out, color:{brightness,contrast,saturation,hue}}]
   * @param {Array}  p.overlays [{inputIndex, kind:'image'|'video', duration, x, y, w, h, opacity, start, end}]
   * @param {Array}  p.captions [{file, fontsize, fontcolor, box, boxcolor, boxborderw, borderw, bordercolor, position, start, end}]
   * @returns {{filterComplex: string, videoLabel: string, audioLabel: string}}
   */
  function buildFilterGraph(p) {
    var W = p.width, H = p.height, FPS = p.fps || 30;
    var sequence = p.sequence || [];
    var overlays = p.overlays || [];
    var captions = p.captions || [];
    if (!sequence.length) {
      throw new Error('sequence must contain at least one clip');
    }

    var parts = [];
    var n = sequence.length;

    sequence.forEach(function (seg, i) {
      var col = seg.color || {};
      var b = num(col.brightness || 0);
      var c = num(col.contrast != null ? col.contrast : 1);
      var s = num(col.saturation != null ? col.saturation : 1);
      var h = num(col.hue || 0);
      parts.push(
        '[' + seg.inputIndex + ':v]trim=start=' + num(seg.in) + ':end=' + num(seg.out) +
        ',setpts=PTS-STARTPTS' +
        ',eq=brightness=' + b + ':contrast=' + c + ':saturation=' + s +
        ',hue=h=' + h +
        ',scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease' +
        ',pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2:color=black' +
        ',fps=' + FPS +
        ',setsar=1' +
        '[v' + i + ']'
      );
      parts.push(
        '[' + seg.inputIndex + ':a]atrim=start=' + num(seg.in) + ':end=' + num(seg.out) +
        ',asetpts=PTS-STARTPTS' +
        ',aformat=sample_rates=44100:channel_layouts=stereo' +
        '[a' + i + ']'
      );
    });

    var videoLabel, audioLabel;
    if (n === 1) {
      videoLabel = 'v0';
      audioLabel = 'a0';
    } else {
      var concatInputs = '';
      for (var i = 0; i < n; i++) concatInputs += '[v' + i + '][a' + i + ']';
      parts.push(concatInputs + 'concat=n=' + n + ':v=1:a=1[vc][ac]');
      videoLabel = 'vc';
      audioLabel = 'ac';
    }

    var cur = videoLabel;
    overlays.forEach(function (ov, j) {
      var ovBase = 'ovsrc' + j;
      var ow = Math.max(1, Math.round(ov.w));
      var oh = Math.max(1, Math.round(ov.h));
      var opacity = num(ov.opacity != null ? ov.opacity : 1);
      if (ov.kind === 'video') {
        parts.push(
          '[' + ov.inputIndex + ':v]trim=start=0:end=' + num(ov.duration) +
          ',setpts=PTS-STARTPTS' +
          ',scale=' + ow + ':' + oh +
          ',format=rgba,colorchannelmixer=aa=' + opacity +
          '[' + ovBase + ']'
        );
      } else {
        parts.push(
          '[' + ov.inputIndex + ':v]scale=' + ow + ':' + oh +
          ',format=rgba,colorchannelmixer=aa=' + opacity +
          '[' + ovBase + ']'
        );
      }
      var next = 'ovl' + j;
      parts.push(
        '[' + cur + '][' + ovBase + ']overlay=x=' + Math.round(ov.x) + ':y=' + Math.round(ov.y) +
        ":enable='between(t," + num(ov.start) + ',' + num(ov.end) + ")'" +
        '[' + next + ']'
      );
      cur = next;
    });

    var audioClips = p.audioClips || [];
    var finalAudioLabel = audioLabel;
    if (audioClips.length) {
      var mixInputs = '[' + audioLabel + ']';
      audioClips.forEach(function (ac, idx) {
        var vol = num(ac.volume != null ? ac.volume : 1);
        var startMs = Math.max(0, Math.round(ac.start * 1000));
        var chain = '[' + ac.inputIndex + ':a]aformat=sample_rates=44100:channel_layouts=stereo,volume=' + vol;
        if (ac.loop) {
          chain += ',aloop=loop=-1:size=2000000000,atrim=0:' + num(ac.duration) + ',asetpts=N/SR/TB';
        } else if (ac.trimDuration) {
          chain += ',atrim=0:' + num(ac.trimDuration) + ',asetpts=N/SR/TB';
        }
        chain += ',adelay=' + startMs + ':all=1[aud' + idx + ']';
        parts.push(chain);
        mixInputs += '[aud' + idx + ']';
      });
      parts.push(mixInputs + 'amix=inputs=' + (audioClips.length + 1) + ':duration=first:normalize=0[mixedaudio]');
      finalAudioLabel = 'mixedaudio';
    }

    captions.forEach(function (cap, k) {
      var lines = cap.lines && cap.lines.length ? cap.lines : [cap.file];
      var fontsize = Math.round(cap.fontsize);
      var ys = lineYPositions(cap.position, H, fontsize, lines.length);
      lines.forEach(function (lineFile, li) {
        var next = 'cap' + k + '_' + li;
        var style = 'fontfile=' + p.fontFile + ':textfile=' + lineFile +
          ':fontsize=' + fontsize + ':fontcolor=' + cap.fontcolor;
        if (cap.box) {
          style += ':box=1:boxcolor=' + cap.boxcolor + ':boxborderw=' + cap.boxborderw;
        }
        if (cap.borderw) {
          style += ':borderw=' + cap.borderw + ':bordercolor=' + cap.bordercolor;
        }
        parts.push(
          '[' + cur + ']drawtext=' + style + ':x=(w-text_w)/2:y=' + ys[li] +
          ":enable='between(t," + num(cap.start) + ',' + num(cap.end) + ")'" +
          '[' + next + ']'
        );
        cur = next;
      });
    });

    return { filterComplex: parts.join(';'), videoLabel: cur, audioLabel: finalAudioLabel };
  }

  var api = { buildFilterGraph: buildFilterGraph };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.FilterGraph = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
