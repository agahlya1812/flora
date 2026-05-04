import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import spiral from './assets/spirale-crop.png';
import './styles.css';

function FloraApp() {
  const [todos, setTodos] = useState([]);
  const lastTodoRef = useRef(null);
  const hasLoadedTodos = useRef(false);

  useEffect(() => {
    lastTodoRef.current?.focus();
  }, [todos.length]);

  useEffect(() => {
    async function loadTodos() {
      const response = await fetch('/api/todos');

      if (!response.ok) {
        throw new Error('Impossible de charger les todos.');
      }

      setTodos(await response.json());
      hasLoadedTodos.current = true;
    }

    loadTodos().catch((error) => {
      hasLoadedTodos.current = true;
      console.error(error);
    });
  }, []);

  const addTodo = () => {
    setTodos((currentTodos) => [
      ...currentTodos,
      {
        id: crypto.randomUUID(),
        title: '',
        done: false,
        isDraft: true,
      },
    ]);
  };

  const updateTodo = (id, title) => {
    setTodos((currentTodos) =>
      currentTodos.map((todo) => (todo.id === id ? { ...todo, title } : todo)),
    );
  };

  const toggleTodo = (id) => {
    const todo = todos.find((currentTodo) => currentTodo.id === id);

    if (!todo) {
      return;
    }

    const done = !todo.done;
    setTodos((currentTodos) =>
      currentTodos.map((currentTodo) =>
        currentTodo.id === id ? { ...currentTodo, done } : currentTodo,
      ),
    );

    if (!todo.isDraft) {
      saveTodo(id, { done });
    }
  };

  const saveTodo = async (id, changes) => {
    try {
      const response = await fetch(`/api/todos/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(changes),
      });

      if (!response.ok) {
        throw new Error('Impossible de sauvegarder le todo.');
      }
    } catch (error) {
      console.error(error);
    }
  };

  const createTodo = async (id, title) => {
    const position = todos.findIndex((todo) => todo.id === id);

    try {
      const response = await fetch('/api/todos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title,
          done: false,
          position: position === -1 ? todos.length : position,
        }),
      });

      if (!response.ok) {
        throw new Error('Impossible de creer le todo.');
      }

      const savedTodo = await response.json();

      setTodos((currentTodos) =>
        currentTodos.map((todo) =>
          todo.id === id ? { ...savedTodo, isDraft: false } : todo,
        ),
      );
    } catch (error) {
      console.error(error);
    }
  };

  const deleteTodo = async (id) => {
    const todo = todos.find((currentTodo) => currentTodo.id === id);

    setTodos((currentTodos) => currentTodos.filter((currentTodo) => currentTodo.id !== id));

    if (!todo || todo.isDraft) {
      return;
    }

    try {
      const response = await fetch(`/api/todos/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Impossible de supprimer le todo.');
      }
    } catch (error) {
      console.error(error);
      setTodos((currentTodos) => [...currentTodos, todo]);
    }
  };

  const validateTodo = (event, id) => {
    if (event.key !== 'Enter') {
      return;
    }

    const title = event.currentTarget.value.trim();

    if (!title) {
      setTodos((currentTodos) => currentTodos.filter((todo) => todo.id !== id));
      return;
    }

    const todo = todos.find((currentTodo) => currentTodo.id === id);

    if (todo?.isDraft) {
      createTodo(id, title);
    } else {
      updateTodo(id, title);
      saveTodo(id, { title });
    }

    event.currentTarget.blur();
  };

  return (
    <main className="screen" aria-label="Todo Flora">
      <img className="spiral-frame" src={spiral} alt="" aria-hidden="true" />
      <section className="home-panel">
        <h1>Flora</h1>

        <div className="todo-list" aria-label="Liste des to do">
          {todos.map((todo, index) => (
            <label className="todo-item" key={todo.id}>
              <input
                className="todo-check"
                type="checkbox"
                checked={todo.done}
                onChange={() => toggleTodo(todo.id)}
                onDoubleClick={() => deleteTodo(todo.id)}
                aria-label="Marquer comme termine"
              />
              <span
                className="todo-check-visual"
                aria-hidden="true"
                onDoubleClick={() => deleteTodo(todo.id)}
              />
              <input
                ref={index === todos.length - 1 ? lastTodoRef : null}
                className="todo-input"
                type="text"
                value={todo.title}
                onChange={(event) => updateTodo(todo.id, event.target.value)}
                onKeyDown={(event) => validateTodo(event, todo.id)}
                placeholder="Nouveau to do"
                aria-label="Nom du to do"
              />
            </label>
          ))}
        </div>

        <button className="add-button" type="button" onClick={addTodo}>
          <span className="add-icon" aria-hidden="true">
            +
          </span>
          <span>Ajouter un to do</span>
        </button>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<FloraApp />);
