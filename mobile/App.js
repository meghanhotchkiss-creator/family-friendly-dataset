import React, { useState } from 'react';
import { SafeAreaView, Text, TextInput, Button, FlatList, View, StyleSheet } from 'react-native';

export default function App() {
  const [state, setState] = useState('CA');
  const [indoor, setIndoor] = useState('Any');
  const [results, setResults] = useState([]);

  const API_URL = 'http://localhost:8000/recommend'; // replace with deployed Cloud Run URL
  const API_KEY = 'mysecretkey';

  const fetchResults = async () => {
    let params = `?state=${state}&limit=5`;
    if (indoor !== 'Any') params += `&indoor=${indoor}`;

    try {
      const response = await fetch(API_URL + params, {
        headers: { 'X-API-Key': API_KEY }
      });
      const data = await response.json();
      setResults(data);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>👨‍👩‍👧 Family-Friendly Activities Finder</Text>
      <Text>Enter State Abbreviation (e.g., CA, TX, FL):</Text>
      <TextInput
        style={styles.input}
        value={state}
        onChangeText={setState}
      />
      <Text>Indoor or Outdoor?</Text>
      <TextInput
        style={styles.input}
        value={indoor}
        onChangeText={setIndoor}
      />
      <Button title="Find Activities" onPress={fetchResults} />
      <FlatList
        data={results}
        keyExtractor={(item, index) => index.toString()}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{item.name}</Text>
            <Text>Type: {item.type || 'N/A'}</Text>
            <Text>State: {item.state || 'N/A'}</Text>
            <Text>Indoor/Outdoor: {item.indoor_or_outdoor || 'N/A'}</Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#fff'
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 20
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: 8,
    marginVertical: 10,
    borderRadius: 5
  },
  card: {
    padding: 15,
    marginVertical: 10,
    backgroundColor: '#f9f9f9',
    borderRadius: 8,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 5
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: 'bold'
  }
});
