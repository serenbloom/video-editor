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
   * Builds x/y/alpha expressions for an animated caption line entrance
   * (and a shared fade-out near the end). Kept purely numeric/expression
   * based since ffmpeg evaluates these per-frame with the `t` variable.
   */
  function animationExprs(anim, outputHeight, targetY, start, end) {
    var entrance = Math.min(0.25, (end - start) * 0.4);
    var exit = Math.min(0.2, (end - start) * 0.4);
    var slideY = Math.round(outputHeight * 0.03);
    var slideX = Math.round(outputHeight * 0.05);
    var tRel = '(t-' + num(start) + ')';
    var alphaExpr = null;
    var xExpr = '(w-text_w)/2';
    var yExpr = String(Math.round(targetY));

    if (anim && anim !== 'none') {
      alphaExpr =
        'if(lt(t-' + num(start) + ',' + num(entrance) + '),' + tRel + '/' + num(entrance) +
        ',if(gt(t,' + num(end - exit) + '),(' + num(end) + '-t)/' + num(exit) + ',1))';
    }
    if (anim === 'slide_up') {
      yExpr = 'if(lt(t-' + num(start) + ',' + num(entrance) + '),' + Math.round(targetY) + '+(1-' + tRel + '/' + num(entrance) + ')*' + slideY + ',' + Math.round(targetY) + ')';
    } else if (anim === 'slide_down') {
      yExpr = 'if(lt(t-' + num(start) + ',' + num(entrance) + '),' + Math.round(targetY) + '-(1-' + tRel + '/' + num(entrance) + ')*' + slideY + ',' + Math.round(targetY) + ')';
    } else if (anim === 'slide_left') {
      xExpr = 'if(lt(t-' + num(start) + ',' + num(entrance) + '),(w-text_w)/2+(1-' + tRel + '/' + num(entrance) + ')*' + slideX + ',(w-text_w)/2)';
    } else if (anim === 'slide_right') {
      xExpr = 'if(lt(t-' + num(start) + ',' + num(entrance) + '),(w-text_w)/2-(1-' + tRel + '/' + num(entrance) + ')*' + slideX + ',(w-text_w)/2)';
    } else if (anim === 'pop') {
      var slideYSmall = Math.round(slideY * 0.6);
      yExpr = 'if(lt(t-' + num(start) + ',' + num(entrance) + '),' + Math.round(targetY) + '+(1-' + tRel + '/' + num(entrance) + ')*' + slideYSmall + ',' + Math.round(targetY) + ')';
    }
    return { xExpr: xExpr, yExpr: yExpr, alphaExpr: alphaExpr };
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
    var hasTransition = sequence.some(function (s, i) { return i > 0 && s.transIn > 0; });
    if (n === 1) {
      videoLabel = 'v0';
      audioLabel = 'a0';
    } else if (!hasTransition) {
      var concatInputs = '';
      for (var i = 0; i < n; i++) concatInputs += '[v' + i + '][a' + i + ']';
      parts.push(concatInputs + 'concat=n=' + n + ':v=1:a=1[vc][ac]');
      videoLabel = 'vc';
      audioLabel = 'ac';
    } else {
      // Mixed chain: a crossfade (xfade/acrossfade) at boundaries with a
      // transition duration, plain concat at any boundary without one
      // (e.g. a clip too short to fit the requested crossfade).
      var curV = 'v0', curA = 'a0';
      for (var j = 1; j < n; j++) {
        var d = sequence[j].transIn || 0;
        if (d > 0) {
          var nv = 'vx' + j, na = 'ax' + j;
          parts.push(
            '[' + curV + '][v' + j + ']xfade=transition=' + (p.transitionType || 'fade') +
            ':duration=' + num(d) + ':offset=' + num(sequence[j].offset) + '[' + nv + ']'
          );
          parts.push('[' + curA + '][a' + j + ']acrossfade=d=' + num(d) + '[' + na + ']');
          curV = nv; curA = na;
        } else {
          var nv2 = 'vx' + j, na2 = 'ax' + j;
          parts.push('[' + curV + '][v' + j + ']concat=n=2:v=1:a=0[' + nv2 + ']');
          parts.push('[' + curA + '][a' + j + ']concat=n=2:v=0:a=1[' + na2 + ']');
          curV = nv2; curA = na2;
        }
      }
      videoLabel = curV;
      audioLabel = curA;
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
        var anim = animationExprs(cap.animation, H, ys[li], cap.start, cap.end);
        if (anim.alphaExpr) style += ":alpha='" + anim.alphaExpr + "'";
        parts.push(
          '[' + cur + ']drawtext=' + style + ":x='" + anim.xExpr + "':y='" + anim.yExpr + "'" +
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
