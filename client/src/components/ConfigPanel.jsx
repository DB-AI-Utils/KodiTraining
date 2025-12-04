import { useState } from 'react'

function ConfigPanel({ config, onChange }) {
  const [useOriginalWidth, setUseOriginalWidth] = useState(config.maxWidth === null)

  const handleCrfChange = (e) => {
    onChange({ ...config, crf: parseInt(e.target.value) })
  }

  const handlePresetChange = (e) => {
    onChange({ ...config, preset: e.target.value })
  }

  const handleMaxWidthChange = (e) => {
    const value = e.target.value === '' ? 1280 : parseInt(e.target.value)
    onChange({ ...config, maxWidth: value })
  }

  const handleOriginalWidthToggle = (e) => {
    const checked = e.target.checked
    setUseOriginalWidth(checked)
    onChange({ ...config, maxWidth: checked ? null : 1280 })
  }

  const handleAudioBitrateChange = (e) => {
    onChange({ ...config, audioBitrate: e.target.value })
  }

  const handleConcatenateFirstToggle = (e) => {
    onChange({ ...config, concatenateFirst: e.target.checked })
  }

  return (
    <div className="config-panel">
      <h3>Processing Settings</h3>

      <div className="config-section">
        <div className="config-item">
          <label className="checkbox-label concatenate-first-label">
            <input
              type="checkbox"
              checked={config.concatenateFirst || false}
              onChange={handleConcatenateFirstToggle}
              className="config-checkbox"
            />
            <span>Concatenate First</span>
          </label>
          <p className="config-hint">
            Use when cameras have different segment lengths. Concatenates all videos from each camera first, then combines side-by-side.
          </p>
        </div>
      </div>

      <h3>Compression Settings</h3>

      <div className="config-section">
        <div className="config-item">
          <label className="config-label">
            <span className="label-text">Video Quality (CRF)</span>
            <span className="label-value">{config.crf}</span>
          </label>
          <div className="crf-slider-container">
            <span className="slider-label left">Higher Quality</span>
            <input
              type="range"
              min="18"
              max="35"
              value={config.crf}
              onChange={handleCrfChange}
              className="slider"
            />
            <span className="slider-label right">Smaller File</span>
          </div>
        </div>

        <div className="config-item">
          <label className="config-label">
            <span className="label-text">Encoding Preset</span>
          </label>
          <select
            value={config.preset}
            onChange={handlePresetChange}
            className="config-select"
          >
            <option value="ultrafast">Ultrafast (fastest, largest)</option>
            <option value="superfast">Superfast</option>
            <option value="veryfast">Very Fast</option>
            <option value="faster">Faster</option>
            <option value="fast">Fast</option>
            <option value="medium">Medium</option>
            <option value="slow">Slow (recommended)</option>
            <option value="slower">Slower</option>
            <option value="veryslow">Very Slow (best compression)</option>
          </select>
        </div>

        <div className="config-item">
          <label className="config-label">
            <span className="label-text">Maximum Width</span>
          </label>
          <div className="width-input-container">
            <input
              type="number"
              min="320"
              max="7680"
              value={useOriginalWidth ? '' : config.maxWidth}
              onChange={handleMaxWidthChange}
              disabled={useOriginalWidth}
              placeholder="1280"
              className="config-input"
            />
            <span className="input-unit">px</span>
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={useOriginalWidth}
              onChange={handleOriginalWidthToggle}
              className="config-checkbox"
            />
            <span>Use original width</span>
          </label>
        </div>

        <div className="config-item">
          <label className="config-label">
            <span className="label-text">Audio Bitrate</span>
          </label>
          <select
            value={config.audioBitrate}
            onChange={handleAudioBitrateChange}
            className="config-select"
          >
            <option value="64k">64k (lower quality)</option>
            <option value="96k">96k (recommended)</option>
            <option value="128k">128k (good quality)</option>
            <option value="192k">192k (high quality)</option>
          </select>
        </div>
      </div>
    </div>
  )
}

export default ConfigPanel
