const axios = require('axios');

async function listModels() {
    const key = 'AIzaSyD4s3Hnmtd0QbueTHL-lIMUxOBz6OObki8';
    try {
        const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        console.log('MODELOS DISPONIBLES:');
        response.data.models.forEach(m => {
            console.log(`- ${m.name} (${m.displayName})`);
        });
    } catch (e) {
        console.error('Error al listar modelos:', e.response?.data || e.message);
    }
}

listModels();
