const fs = require('fs');
const path = require('path');

class Storage {
  constructor(outputPath) {
    this.outputPath = outputPath;
    this.configPath = path.join(outputPath, '.snapy-config.json');
    this.videosPath = path.join(outputPath, '.videos.json');

    this.ensureFiles();
  }

  ensureFiles() {
    if (!fs.existsSync(this.configPath)) {
      this.writeConfig({
        outputPath: this.outputPath,
        format: 'mp4',
        quality: 'best',
        autoUpdate: true,
      });
    }

    if (!fs.existsSync(this.videosPath)) {
      this.writeVideos([]);
    }
  }

  writeConfig(config) {
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }

  writeVideos(videos) {
    fs.writeFileSync(this.videosPath, JSON.stringify(videos, null, 2));
  }

  readConfig() {
    try {
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch {
      return {};
    }
  }

  readVideos() {
    try {
      return JSON.parse(fs.readFileSync(this.videosPath, 'utf8'));
    } catch {
      return [];
    }
  }

  getOutputPath() {
    const config = this.readConfig();
    return config.outputPath || this.outputPath;
  }

  setOutputPath(newPath) {
    const config = this.readConfig();
    config.outputPath = newPath;
    this.outputPath = newPath;
    this.writeConfig(config);
  }

  getPreferences() {
    const config = this.readConfig();
    return {
      format:           config.format           || 'mp4',
      quality:          config.quality          || 'best',
      autoUpdate:       config.autoUpdate       !== false,
      autoStart:        config.autoStart        || false,
      autoStartFormat:  config.autoStartFormat  || 'mp4',
      autoStartQuality: config.autoStartQuality || 'best',
    };
  }

  setPreferences(prefs) {
    const config = this.readConfig();
    Object.assign(config, prefs);
    this.writeConfig(config);
  }

  getVideos() {
    const videos = this.readVideos();
    return videos
      .map((video) => {
        const filepath = path.join(this.getOutputPath(), video.filename);
        if (!fs.existsSync(filepath)) {
          return null;
        }
        return video;
      })
      .filter(Boolean)
      .reverse();
  }

  addVideo(videoMetadata) {
    const videos = this.readVideos();
    videos.push(videoMetadata);
    this.writeVideos(videos);
  }

  deleteVideo(filename) {
    const videos = this.readVideos();
    const filtered = videos.filter((v) => v.filename !== filename);
    this.writeVideos(filtered);

    const filepath = path.join(this.getOutputPath(), filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }

    return true;
  }
}

module.exports = Storage;
