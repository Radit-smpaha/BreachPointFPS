// QA probe - automated testing utility
const THREE = require('three');
const { GLTFLoader } = require('three/addons/GLTFLoader.js');

const loader = new GLTFLoader();

export class QAProbe {
    constructor(game) {
        this.game = game;
        this.results = [];
    }

    async probe(mapName) {
        return new Promise((resolve, reject) => {
            const loader = new GLTFLoader();
            loader.load(`assets/maps/${mapName}.glb`, (gltf) => {
                resolve({ map: mapName, gltf: gltf.scene, success: true });
            }, (error) => {
                reject(new Error(`Failed to load map ${mapName}: ${error.message}`));
            }
        });
    }
}

module.exports = { QAProbe };