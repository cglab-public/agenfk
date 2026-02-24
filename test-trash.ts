
import axios from 'axios';

async function test() {
  try {
    const res = await axios.post('http://localhost:3000/items/trash-archived', {
      projectId: 'duaa8dto2g6wdyc75bvbuh'
    });
    console.log('Success:', res.status, res.data);
  } catch (e: any) {
    if (e.response) {
      console.log('Error:', e.response.status, e.response.data);
    } else {
      console.log('Error:', e.message);
    }
  }
}

test();
