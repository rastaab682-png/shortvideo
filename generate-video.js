#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const sharp = require('sharp');
const winston = require('winston');
require('dotenv').config();

// Configure logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'youtube-short-generator' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

class YouTubeShortGenerator {
  constructor() {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is missing. Get it from https://makersuite.google.com/app/apikey');
    }
    
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.outputDir = path.join(__dirname, 'output');
    this.ensureOutputDir();
    
    this.validateEnvVars();
  }

  ensureOutputDir() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
      logger.info('Created output directory');
    }
  }

  validateEnvVars() {
    const requiredVars = ['GEMINI_API_KEY', 'PEXELS_API_KEY', 'YT_CLIENT_ID', 'YT_CLIENT_SECRET', 'YT_REFRESH_TOKEN'];
    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }
    
    if (!process.env.ELEVENLABS_API_KEY || !process.env.DEFAULT_VOICE_ID) {
      logger.warn('⚠️  ELEVENLABS_API_KEY or DEFAULT_VOICE_ID not found. TTS will fail.');
    }
  }

  async generateContent() {
    try {
      logger.info('Generating construction tip content with Gemini...');
      
      const prompt = `Generate 20 Persian titles for construction/maintenance tips YouTube Shorts. Each title should be catchy, informative, and under 60 characters. Focus on practical tips, maintenance advice, and safety awareness (not dangerous procedures). Return as JSON array of strings.`;
      
      const model = this.genAI.getGenerativeModel({ 
        model: "gemini-1.5-pro",
        generationConfig: {
          responseMimeType: 'application/json'
        }
      });
      
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const titles = JSON.parse(response.text());
      
      const selectedTitle = titles[Math.floor(Math.random() * titles.length)];
      logger.info(`Selected title: ${selectedTitle}`);
      
      const scriptPrompt = `Write a 30-45 second YouTube Shorts script in Persian for the title: "${selectedTitle}". The script should be informative, engaging, and focus on practical construction/maintenance tips or safety awareness. Avoid dangerous instructions or structural procedures. Return as JSON with "script" and "key_points" fields.`;
      
      const scriptResult = await model.generateContent(scriptPrompt);
      const scriptResponse = await scriptResult.response;
      const content = JSON.parse(scriptResponse.text());
      
      return {
        title: selectedTitle,
        script: content.script,
        keyPoints: content.key_points
      };
    } catch (error) {
      logger.error('Error generating content:', error);
      throw error;
    }
  }

  async generateTTS(text, outputPath) {
    try {
      logger.info('Generating text-to-speech with ElevenLabs...');
      
      if (!process.env.ELEVENLABS_API_KEY || !process.env.DEFAULT_VOICE_ID) {
        throw new Error('ELEVENLABS_API_KEY and DEFAULT_VOICE_ID are required for TTS. Get them from https://elevenlabs.io/ (free tier available)');
      }

      const response = await axios({
        method: 'post',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${process.env.DEFAULT_VOICE_ID}`,
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        data: {
          text: text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5
          }
        },
        responseType: 'stream'
      });

      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);
      
      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          logger.info('TTS generated successfully');
          resolve();
        });
        writer.on('error', reject);
      });
      
    } catch (error) {
      logger.error('Error generating TTS:', error);
      throw error;
    }
  }

  async downloadBrollImages(keyPoints, outputDir) {
    try {
      logger.info('Downloading B-roll images...');
      const images = [];
      
      for (let i = 0; i < Math.min(keyPoints.length, 5); i++) {
        const searchTerm = keyPoints[i];
        const response = await axios.get('https://api.pexels.com/v1/search', {
          headers: {
            Authorization: process.env.PEXELS_API_KEY
          },
          params: {
            query: `construction ${searchTerm}`,
            per_page: 5,
            orientation: 'portrait'
          }
        });

        if (response.data.photos.length > 0) {
          const photo = response.data.photos[Math.floor(Math.random() * response.data.photos.length)];
          const imageResponse = await axios.get(photo.src.medium, {
            responseType: 'stream'
          });

          const imagePath = path.join(outputDir, `broll_${i}.jpg`);
          const writer = fs.createWriteStream(imagePath);
          imageResponse.data.pipe(writer);
          
          await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
          });

          images.push(imagePath);
          logger.info(`Downloaded image ${i + 1}: ${photo.src.medium}`);
        }
      }

      return images;
    } catch (error) {
      logger.error('Error downloading B-roll images:', error);
      return await this.createPlaceholderImages(keyPoints.length, outputDir); // ✅ await اضافه شد
    }
  }

  async createPlaceholderImages(count, outputDir) { // ✅ async اضافه شد
    const placeholderPath = path.join(__dirname, 'placeholder.jpg');
    const images = [];
    
    try {
      for (let i = 0; i < Math.min(count, 5); i++) {
        const imagePath = path.join(outputDir, `broll_${i}.jpg`);
        if (fs.existsSync(placeholderPath)) {
          fs.copyFileSync(placeholderPath, imagePath);
        } else {
          // Create a simple placeholder if file doesn't exist
          const svg = `<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#333"/></svg>`;
          const img = sharp(Buffer.from(svg));
          await img.jpeg({ quality: 80 }).toFile(imagePath); // ✅ این await حالا کار می‌کند
        }
        images.push(imagePath);
      }
    } catch (e) {
      logger.error('Error creating placeholder images:', e);
    }
    
    logger.warn('Using placeholder images due to download failure');
    return images;
  }

  async createVideo(content, audioPath, images, outputPath) {
    try {
      logger.info('Creating video with FFmpeg...');
      
      const { script } = content;
      const videoLength = 35;
      const imageDuration = videoLength / images.length;
      
      const concatListPath = path.join(this.outputDir, 'input_list.txt');
      const concatList = images.map(img => `file '${img}'\nduration ${imageDuration}`).join('\n');
      fs.writeFileSync(concatListPath, concatList);

      return new Promise((resolve, reject) => {
        ffmpeg()
          .input(concatListPath)
          .inputFormat('concat')
          .inputOptions(['-safe 0'])
          .input(audioPath)
          .outputOptions([
            '-c:v libx264',
            '-c:a aac',
            '-strict experimental',
            '-shortest',
            '-vf scale=1080:1920,setsar=1:1',
            '-r 30',
            '-b:v 5000k',
            '-b:a 192k',
            '-pix_fmt yuv420p'
          ])
          .output(outputPath)
          .on('end', () => {
            logger.info('Video created successfully');
            resolve();
          })
          .on('error', (err) => {
            logger.error('FFmpeg error:', err);
            reject(err);
          })
          .run();
      });
    } catch (error) {
      logger.error('Error creating video:', error);
      throw error;
    }
  }

  async generateThumbnail(content, outputPath) {
    try {
      logger.info('Generating thumbnail...');
      
      const { title } = content;
      const width = 1080;
      const height = 1920;
      
      const svg = `
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="#FF6B35"/>
          <rect x="50" y="600" width="980" height="800" fill="rgba(0,0,0,0.7)" rx="20"/>
          <text x="540" y="1000" font-family="Arial, sans-serif" font-size="80" fill="white" text-anchor="middle" dominant-baseline="middle" font-weight="bold">
            ${title}
          </text>
          <text x="540" y="1400" font-family="Arial, sans-serif" font-size="40" fill="#FFD700" text-anchor="middle">
            ترفندهای عمرانی
          </text>
        </svg>
      `;

      await sharp(Buffer.from(svg))
        .resize(width, height)
        .jpeg({ quality: 90 })
        .toFile(outputPath);

      logger.info('Thumbnail generated successfully');
    } catch (error) {
      logger.error('Error generating thumbnail:', error);
      throw error;
    }
  }

  async generateSRT(content, audioPath, outputPath) {
    try {
      logger.info('Generating SRT subtitles...');
      
      const { script } = content;
      const sentences = script.split(/[.!?]+/).filter(s => s.trim().length > 0);
      const duration = 35;
      const timePerSentence = duration / sentences.length;
      
      let srtContent = '';
      
      for (let i = 0; i < sentences.length; i++) {
        const startTime = this.formatSRTTime(i * timePerSentence);
        const endTime = this.formatSRTTime((i + 1) * timePerSentence);
        
        srtContent += `${i + 1}\n`;
        srtContent += `${startTime} --> ${endTime}\n`;
        srtContent += `${sentences[i].trim()}\n\n`;
      }
      
      fs.writeFileSync(outputPath, srtContent);
      logger.info('SRT file generated successfully');
    } catch (error) {
      logger.error('Error generating SRT:', error);
      throw error;
    }
  }

  formatSRTTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
  }

  async uploadToYouTube(videoPath, thumbnailPath, content) {
    try {
      logger.info('Uploading to YouTube...');
      
      const oauth2Client = new google.auth.OAuth2(
        process.env.YT_CLIENT_ID,
        process.env.YT_CLIENT_SECRET,
        'http://localhost:3000/callback'
      );
      
      oauth2Client.setCredentials({
        refresh_token: process.env.YT_REFRESH_TOKEN
      });

      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
      
      const videoResponse = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
          snippet: {
            title: content.title,
            description: `${content.script}\n\n#ترفندهای_عمرانی #ساختمان #آموزش`,
            tags: ['ترفندهای عمرانی', 'ساختمان', 'آموزش', 'construction', 'tips'],
            categoryId: '28'
          },
          status: {
            privacyStatus: 'public',
            madeForKids: false
          }
        },
        media: {
          body: fs.createReadStream(videoPath)
        }
      });

      const videoId = videoResponse.data.id;
      logger.info(`Video uploaded successfully. Video ID: ${videoId}`);

      if (thumbnailPath) {
        await youtube.thumbnails.set({
          videoId: videoId,
          media: {
            body: fs.createReadStream(thumbnailPath)
          }
        });
        logger.info('Thumbnail uploaded successfully');
      }

      return {
        videoId: videoId,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        shortUrl: `https://www.youtube.com/shorts/${videoId}`
      };
    } catch (error) {
      logger.error('Error uploading to YouTube:', error);
      throw error;
    }
  }

  async generate() {
    try {
      logger.info('Starting YouTube Short generation...');
      
      const content = await this.generateContent();
      
      const audioPath = path.join(this.outputDir, 'audio.mp3');
      await this.generateTTS(content.script, audioPath);
      
      const images = await this.downloadBrollImages(content.keyPoints, this.outputDir);
      
      const videoPath = path.join(this.outputDir, 'output.mp4');
      await this.createVideo(content, audioPath, images, videoPath);
      
      const thumbnailPath = path.join(this.outputDir, 'thumbnail.jpg');
      await this.generateThumbnail(content, thumbnailPath);
      
      const srtPath = path.join(this.outputDir, 'subtitles.srt');
      await this.generateSRT(content, audioPath, srtPath);
      
      const uploadResult = await this.uploadToYouTube(videoPath, thumbnailPath, content);
      
      logger.info('YouTube Short generated and uploaded successfully!');
      logger.info(`Video URL: ${uploadResult.videoUrl}`);
      logger.info(`Short URL: ${uploadResult.shortUrl}`);
      
      return {
        success: true,
        videoId: uploadResult.videoId,
        videoUrl: uploadResult.videoUrl,
        shortUrl: uploadResult.shortUrl,
        title: content.title,
        outputFiles: {
          video: videoPath,
          thumbnail: thumbnailPath,
          audio: audioPath,
          subtitles: srtPath
        }
      };
    } catch (error) {
      logger.error('Error in video generation:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

if (require.main === module) {
  const generator = new YouTubeShortGenerator();
  generator.generate()
    .then(result => {
      if (result.success) {
        console.log('\n✅ YouTube Short generated successfully!');
        console.log(`Title: ${result.title}`);
        console.log(`Video URL: ${result.videoUrl}`);
        console.log(`Short URL: ${result.shortUrl}`);
        process.exit(0);
      } else {
        console.error('\n❌ Error generating YouTube Short:', result.error);
        process.exit(1);
      }
    })
    .catch(error => {
      console.error('\n❌ Unexpected error:', error);
      process.exit(1);
    });
}

module.exports = YouTubeShortGenerator;
