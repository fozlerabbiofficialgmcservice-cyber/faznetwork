const express = require('express'); 
const app = express(); 
const PORT = process.env.PORT || 8080; 

app.use(express.json()); 

app.get('/', (req, res) => { 
    res.send('Welcome!'); 
}); 

app.post('/forward', (req, res) => { 
    console.log('Received data:', req.body); 
    res.status(200).send('Message received'); 
}); 

app.listen(PORT, () => { 
    console.log(`Server is running on port ${PORT}`); 
});
